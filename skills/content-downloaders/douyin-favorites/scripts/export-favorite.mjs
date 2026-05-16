import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const outputPath = process.env.DOUYIN_OUTPUT || "downloads/douyin/favorite-video.md";
const screenshotDir = process.env.DOUYIN_SCREENSHOT_DIR || "downloads/douyin/screenshots";
const transcriptPath = process.env.DOUYIN_TRANSCRIPT_FILE || "";
const transcriptText = process.env.DOUYIN_TRANSCRIPT_TEXT || "";
const title = process.env.DOUYIN_TITLE || "未命名收藏视频";
const author = process.env.DOUYIN_AUTHOR || "未知";
const videoUrl = process.env.DOUYIN_VIDEO_URL || "";
const clickSequence = process.env.DOUYIN_CLICK_SEQUENCE || "";

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout || "";
}

function activateDouyin() {
  run("open", ["-a", "抖音"]);
  run("osascript", ["-e", 'tell application "抖音" to activate']);
}

function windowGeometry() {
  const script = [
    'tell application "System Events" to tell process "抖音"',
    "set p to position of window 1",
    "set s to size of window 1",
    'return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)',
    "end tell",
  ].join("\n");
  const raw = run("osascript", ["-e", script]).trim();
  const [x, y, width, height] = raw.split(",").map((part) => Number(part.trim()));
  if ([x, y, width, height].some((value) => Number.isNaN(value))) {
    throw new Error(`Could not parse Douyin window geometry: ${raw}`);
  }
  return { x, y, width, height };
}

function ensureClickHelper() {
  const helperPath = path.join(os.tmpdir(), "douyin-desktop-click");
  if (fs.existsSync(helperPath)) return helperPath;

  const sourcePath = `${helperPath}.c`;
  fs.writeFileSync(
    sourcePath,
    `#include <ApplicationServices/ApplicationServices.h>
#include <unistd.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  CGPoint p = CGPointMake(atof(argv[1]), atof(argv[2]));
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, p, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, p, kCGMouseButtonLeft);
  if (!move || !down || !up) return 3;
  CGEventPost(kCGHIDEventTap, move);
  usleep(100000);
  CGEventPost(kCGHIDEventTap, down);
  usleep(80000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(move);
  CFRelease(down);
  CFRelease(up);
  return 0;
}
`,
    "utf8",
  );
  run("clang", ["-framework", "ApplicationServices", sourcePath, "-o", helperPath]);
  return helperPath;
}

function clickRelative(helperPath, geometry, relX, relY) {
  const x = Math.round(geometry.x + relX * geometry.width);
  const y = Math.round(geometry.y + relY * geometry.height);
  run(helperPath, [String(x), String(y)]);
}

function captureScreenshot(label) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  const filePath = path.join(screenshotDir, `${label}-${Date.now()}.png`);
  run("screencapture", ["-x", filePath]);
  return filePath;
}

async function clickLatestFavorite() {
  activateDouyin();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const geometry = windowGeometry();
  const helperPath = ensureClickHelper();

  // Relative positions match Douyin desktop's left rail and profile grid. Override by opening manually if layout changes.
  clickRelative(helperPath, geometry, 0.06, 0.84); // 我的
  await new Promise((resolve) => setTimeout(resolve, 2500));
  clickRelative(helperPath, geometry, 0.28, 0.24); // 收藏 tab area
  await new Promise((resolve) => setTimeout(resolve, 2500));
  clickRelative(helperPath, geometry, 0.28, 0.42); // first collected video card
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return captureScreenshot("opened-favorite");
}

function readTranscript() {
  if (transcriptText) return cleanText(transcriptText);
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    return cleanText(fs.readFileSync(transcriptPath, "utf8"));
  }
  return "";
}

function buildMarkdown({ screenshotPath, transcript }) {
  const safeUrl = sanitizeUrl(videoUrl);
  return `# 抖音收藏视频文字记录：${escapeMd(title)}

- 采集时间：${nowStamp()}
- 视频链接：${safeUrl ? `<${safeUrl}>` : "未获取"}
- 作者：${escapeMd(author)}
- 转写类型：${transcript ? "人工/ASR 转写文本" : "桌面播放定位记录，待转写"}
- 截图证据：${screenshotPath}

## 转写文本

${transcript || "尚未生成音频转写。请先打开收藏视频播放页，并提供本地 ASR 结果或启用可用 ASR 工具后重跑。"}

## 说明

- 本脚本只使用桌面端登录态和鼠标/截图自动化，不读取、不复制、不解密 Cookie、Token、LocalStorage 或 Keychain。
- 如果当前环境无法捕获抖音窗口画面，请手动把第一个收藏视频打开到播放页，再运行同一脚本写入截图和转写文本。
- 真正的语音转写需要本地 ASR 工具或用户提供转写文本；不要把页面文案伪装成完整语音稿。
`;
}

let screenshotPath = "";
if (clickSequence === "latest-favorite") {
  screenshotPath = await clickLatestFavorite();
} else {
  activateDouyin();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  screenshotPath = captureScreenshot("current");
}

const markdown = buildMarkdown({ screenshotPath, transcript: readTranscript() });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, markdown, "utf8");
console.log(`Wrote ${outputPath}`);
console.log(`Screenshot: ${screenshotPath}`);
