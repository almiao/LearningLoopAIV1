import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const xhsHomeUrl = "https://www.xiaohongshu.com/explore";
const profileUrl = process.env.XHS_PROFILE_URL || "";
const noteUrl = process.env.XHS_NOTE_URL || "";
const noteQuery = process.env.XHS_NOTE_QUERY || "";
const outputPath = process.env.XHS_OUTPUT || "downloads/xiaohongshu/favorite.md";
const port = Number(process.env.XHS_CDP_PORT || 9224);
const chromeProfileRoot =
  process.env.XHS_CHROME_PROFILE ||
  path.join(os.homedir(), "Library/Application Support/Google/Chrome");

const loginMessage =
  "Xiaohongshu login was not available. Log in to Xiaohongshu in normal Chrome, then rerun this skill.";

const copyItems = [
  "Local State",
  "Default/Cookies",
  "Default/Network",
  "Default/Preferences",
  "Default/Local Storage",
  "Default/Session Storage",
  "Default/IndexedDB",
  "Default/WebStorage",
];

function cleanText(value) {
  return (value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeMd(value) {
  return cleanText(value).replace(/\|/g, "\\|");
}

function sanitizeUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("?")[0].split("#")[0];
  }
}

function nowStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date());
}

async function cdpWebSocketUrl() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome CDP endpoint did not start on port ${port}.`);
}

function prepareTempProfile() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-favorite-"));
  for (const item of copyItems) {
    const source = path.join(chromeProfileRoot, item);
    const target = path.join(tempRoot, item);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync("ditto", [source, target]);
  }
  return tempRoot;
}

async function closeAlerts(page) {
  await page.getByText("我知道了", { exact: true }).last().click({ timeout: 1000 }).catch(() => {});
}

async function discoverLoggedInProfileUrl(page) {
  await page.goto(xhsHomeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5000);
  await closeAlerts(page);
  const found = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || "").trim(),
          href: el.href,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => item.width > 0 && item.height > 0);
    return anchors.find((item) => item.text === "我" && item.href.includes("/user/profile/"))?.href || "";
  });
  if (!found) throw new Error(loginMessage);
  return found;
}

async function clickVisibleCollectTab(page) {
  const clicked = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll(".reds-tab-item")]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, text: (el.innerText || "").trim(), rect };
      })
      .filter((item) => item.text === "收藏" && item.rect.width > 0 && item.rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top);
    const target = candidates[0];
    target?.el.click();
    return Boolean(target);
  });
  if (!clicked) throw new Error(`${loginMessage} The visible 收藏 tab was not found.`);
  await page.waitForTimeout(2500);
}

async function findFavoriteHref(page) {
  return page.evaluate((query) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= 200 &&
        rect.top >= 380 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };
    const candidates = [...document.querySelectorAll("a.title")]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          href: el.href,
          text: (el.innerText || el.textContent || "").trim(),
          top: rect.top,
          left: rect.left,
        };
      })
      .filter((item) => item.href && (!query || item.text.includes(query)))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    return candidates[0] || null;
  }, noteQuery);
}

async function extractNote(page) {
  return page.evaluate(() => {
    const clean = (value) =>
      (value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const body = clean(document.body.innerText);
    const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
    const title = clean(document.title.replace(/ - 小红书$/, ""));
    const titleIndex = lines.findIndex((line) => line === title);
    const author = titleIndex > 1 ? lines[titleIndex - 2] : "";
    const afterTitle = titleIndex >= 0 ? lines.slice(titleIndex + 1) : [];
    const dateIndex = afterTitle.findIndex((line) => /^\d{2}-\d{2}/.test(line));
    const bodyLines = dateIndex >= 0 ? afterTitle.slice(0, dateIndex) : afterTitle.slice(0, 8);
    const dateLocation = dateIndex >= 0 ? afterTitle[dateIndex] : "";
    const commentLine = lines.find((line) => /^共\s*\d+\s*条评论$/.test(line)) || "";
    const images = [...document.querySelectorAll("img")]
      .filter(visible)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        return { src: img.currentSrc || img.src || "", width: rect.width, height: rect.height };
      })
      .filter((img) => img.src && img.width >= 200 && img.height >= 200 && !img.src.startsWith("data:"))
      .map((img) => img.src);
    return {
      url: location.href,
      title,
      author,
      dateLocation,
      bodyText: clean(bodyLines.join("\n")),
      commentLine,
      images: [...new Set(images)].slice(0, 8),
    };
  });
}

function buildMarkdown(note, favoriteCard) {
  const sourceUrl = sanitizeUrl(note.url);
  const tags = [...note.bodyText.matchAll(/#[^\s#]+/g)].map((match) => match[0].slice(1));
  const textWithoutTags = cleanText(note.bodyText.replace(/#[^\s#]+/g, ""));
  const excerpt = textWithoutTags.split(/[。！？\n]/).filter(Boolean).slice(0, 2).join("。");
  const summary = textWithoutTags || "未能提取到正文摘要。";
  const images = note.images.map(sanitizeUrl).filter(Boolean);

  return `# 小红书收藏：${escapeMd(note.title || favoriteCard?.text || "未命名笔记")}

- 采集时间：${nowStamp()}
- 原帖链接：<${sourceUrl}>
- 作者：${escapeMd(note.author || "未知")}
- 发布时间与地点：${escapeMd(note.dateLocation || "未知")}
- 评论信息：${escapeMd(note.commentLine || "未显示")}

## 短摘录

> ${escapeMd(excerpt || note.title)}

## 内容整理

${summary}

## 标签

${tags.length ? tags.map((tag) => `- ${escapeMd(tag)}`).join("\n") : "- 未提取到标签"}

## 图片

${images.length ? images.map((src) => `- <${src}>`).join("\n") : "- 未提取到主图链接"}

## 处理记录

1. 使用临时 Chrome profile 连接已登录小红书。
2. ${noteUrl ? "打开指定笔记 URL。" : "进入登录账号的个人主页并点击顶部可见的「收藏」tab。"}
3. ${!noteUrl && noteQuery ? `按标题关键词 \`${escapeMd(noteQuery)}\` 选择收藏卡片。` : !noteUrl ? "选择第一张可见收藏卡片。" : "提取当前笔记详情。"}
4. 输出前移除原帖 URL 中的查询参数，避免保存会话 token。
`;
}

const tempProfile = prepareTempProfile();
let browser;

try {
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`]);
  spawnSync("open", [
    "-na",
    "Google Chrome",
    "--args",
    `--user-data-dir=${tempProfile}`,
    "--profile-directory=Default",
    `--remote-debugging-port=${port}`,
    noteUrl || profileUrl || xhsHomeUrl,
  ]);

  browser = await chromium.connectOverCDP(await cdpWebSocketUrl());
  const context = browser.contexts()[0];
  const page = context.pages().find((candidate) => candidate.url().includes("xiaohongshu.com")) || await context.newPage();

  let targetUrl = noteUrl;
  let favoriteCard = null;
  if (!targetUrl) {
    const targetProfileUrl = profileUrl || (await discoverLoggedInProfileUrl(page));
    await page.goto(targetProfileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5000);
    await closeAlerts(page);
    await clickVisibleCollectTab(page);
    favoriteCard = await findFavoriteHref(page);
    if (!favoriteCard) throw new Error(`Could not find a favorite note${noteQuery ? ` matching ${noteQuery}` : ""}.`);
    targetUrl = favoriteCard.href;
  }

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(8000);
  await closeAlerts(page);

  const note = await extractNote(page);
  const markdown = buildMarkdown(note, favoriteCard);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, "utf8");
  console.log(`Wrote ${outputPath}`);
  console.log(`Title: ${note.title}`);
  console.log(`URL: ${sanitizeUrl(note.url)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  spawnSync("pkill", ["-f", `remote-debugging-port=${port}`]);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    fs.rmSync(tempProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    spawnSync("rm", ["-rf", tempProfile]);
  }
}
