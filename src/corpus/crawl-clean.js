// 爬取语料清洗 — 把 newcode-craw 的原始抓取转成 app 自有的干净 corpus 记录。
//
// 原始 BOSS直聘 JD 的 job_description 混了大量页面杂质（顶部导航、底部页脚、
// 招聘者活跃状态、推荐职位、ICP 备案…）；牛客面经的 content_text 基本是真题列表，
// 只夹少量引流广告。这里用启发式剥壳，产出能直接喂 decompose 的正文。
//
// 纯函数、无 IO，供导入脚本（scripts/import-crawl-corpus.mjs）与未来的检索 API 复用，单测兜底。

// JD 顶部导航行（整行命中即丢）。
const JD_NAV_LINES = new Set([
  "首页", "职位", "公司", "校园", "海归", "APP", "有了", "海外", "无障碍专区",
  "搜索", "消息", "简历", "招聘中", "立即沟通", "感兴趣 立即沟通", "感兴趣",
  "完善在线简历", "新增附件简历", "BOSS", "公司基本信息", "查看全部职位",
  "微信扫码分享", "举报", "微信扫码分享 举报",
]);

// JD 正文结束标记：命中即从此行起截断（含本行）。覆盖招聘者卡片、安全提示、公司介绍、页脚。
const JD_TAIL_MARKERS = [
  "竞争力分析", "查看完整个人竞争力", "个人综合排名", "BOSS 安全提示", "BOSS安全提示",
  "BOSS直聘严禁", "公司介绍", "工作地址", "点击查看地图", "更多职位", "看过该职位",
  "精选职位", "企业服务热线", "BOSS直聘APP", "投资者关系", "直品公益", "使用与帮助",
  "协议与规则", "隐私政策", "防骗指南", "使用帮助", "联系BOSS直聘", "Copyright",
  "京ICP", "公司地址", "违法和不良信息", "老年人直连热线", "企业服务", "职位搜索",
];

// 招聘者活跃状态行（如「刚刚活跃」「3分钟前活跃」「在线」）——出现即视为正文结束。
const JD_ACTIVITY_RE = /^(刚刚活跃|在线|\d+\s*(分钟|小时|天|月|周)前活跃)$/;

// 面经引流广告行（整段含这些词即丢）。
const REPORT_PROMO_RE = /(后台联系|加微信|公众号|求职辅导|项目辅导|欢迎私信|欢迎后台|真题和解析|查看\d+道|点赞|关注我|内推码|扫码)/;

function splitLines(raw = "") {
  return String(raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function lastIndexOfLine(lines, target) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i] === target) {
      return i;
    }
  }
  return -1;
}

function looksLikeName(line = "") {
  // 招聘者姓名残留：2-4 个汉字、无标点数字。用来削掉正文末尾夹带的招聘者名。
  return /^[一-龥]{2,4}$/.test(line);
}

export function cleanJobDescription(raw = "") {
  const lines = splitLines(raw);
  if (!lines.length) {
    return "";
  }
  // 正文从最后一个「职位描述」之后开始；没有这个锚点就退而丢掉顶部导航行。
  const anchor = lastIndexOfLine(lines, "职位描述");
  const body = anchor >= 0 ? lines.slice(anchor + 1) : lines.filter((line) => !JD_NAV_LINES.has(line));

  const out = [];
  for (const line of body) {
    if (JD_ACTIVITY_RE.test(line) || JD_TAIL_MARKERS.some((marker) => line.includes(marker))) {
      break;
    }
    out.push(line);
  }
  // 末尾若残留招聘者姓名单行，削掉。
  while (out.length && looksLikeName(out[out.length - 1])) {
    out.pop();
  }
  return out.join("\n").trim();
}

export function cleanInterviewText(raw = "") {
  const lines = splitLines(raw).filter((line) => !REPORT_PROMO_RE.test(line));
  return lines.join("\n").trim();
}

function pickTag(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeJdRecord(raw = {}, { source = "zhipin" } = {}) {
  const text = cleanJobDescription(raw.job_description || "");
  const title = String(raw.title || "").trim();
  const keyword = String(raw.job_context?.keyword || "").trim();
  return {
    id: String(raw.content_id || raw.job_id || "").trim(),
    source,
    kind: "jd",
    title,
    role: keyword,
    experience: String(raw.experience || "").trim(),
    tags: pickTag(raw.tags).slice(0, 8),
    text,
    url: String(raw.detail_url || "").trim(),
  };
}

export function normalizeInterviewRecord(raw = {}, { source = "nowcoder" } = {}) {
  const text = cleanInterviewText(raw.content_text || "");
  return {
    id: String(raw.content_id || raw.uuid || "").trim(),
    source,
    kind: "interview",
    title: String(raw.title || "").trim(),
    role: String(raw.job_context?.shard_name || raw.job_context?.shard_path || "").trim(),
    text,
    url: String(raw.detail_url || raw.url || "").trim(),
  };
}
