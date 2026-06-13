import { getLatestResumeVersion } from "../../../src/user/resume-version-store.js";
import { selectLoopAssistSeeds } from "../../../src/loopassist/corpus.js";
import { getUserProfile } from "./profile-domain.js";
import { getLibraryItem } from "./corpus-library.js";
import { proxyJson } from "./service-proxy.js";

// 面试冲刺域 — PRODUCT.md「面试冲刺」的 BFF 编排层。
//
// 守 §1.3：这里没有第二个引擎。话题 practice 复用的是与复习 practice 完全相同的三个零件
// （/api/review/generate-question 出题、/api/anchor-judge 判分、rescue-material 补讲），
// 只是种子从「复习项」换成「JD 话题」——这就是"参数化"的全部。
// 覆盖度写 Goal（per-Goal、随战役生灭），失败写账本（全局、持久）——碰过 ≠ 会。

const DAY_MS = 24 * 60 * 60 * 1000;
const jdExcerptLimit = 2400;
const topicSourceRisk = {
  "resume-claim": 3,
  "jd-topic": 2,
  "report-seed": 1,
};

// 就绪度的诚实边界（PRODUCT「面试冲刺」就绪度节）：必须随读数一起返回，否则误导。
export const READINESS_DISCLAIMER =
  "达标度只和锚点判分质量、JD 拆解质量一样准；覆盖率 ≠ 达标度 ≠ 真能过面。这是你自己的薄弱点地图，不是录用预测。";

function normalizeText(value = "") {
  return String(value || "").trim();
}

function clipText(value = "", limit = jdExcerptLimit) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function parseCampaignPath(pathname = "") {
  const detail = /^\/api\/campaigns\/([^/]+)$/.exec(pathname);
  if (detail) {
    return { id: decodeURIComponent(detail[1]), action: "detail", topicId: "" };
  }
  const action = /^\/api\/campaigns\/([^/]+)\/(archive|debrief)$/.exec(pathname);
  if (action) {
    return { id: decodeURIComponent(action[1]), action: action[2], topicId: "" };
  }
  const practice = /^\/api\/campaigns\/([^/]+)\/topics\/([^/]+)\/practice$/.exec(pathname);
  if (practice) {
    return { id: decodeURIComponent(practice[1]), action: "practice", topicId: decodeURIComponent(practice[2]) };
  }
  const rescue = /^\/api\/campaigns\/([^/]+)\/topics\/([^/]+)\/rescue$/.exec(pathname);
  if (rescue) {
    return { id: decodeURIComponent(rescue[1]), action: "rescue", topicId: decodeURIComponent(rescue[2]) };
  }
  return null;
}

export function daysUntil(deadline, now = new Date()) {
  const deadlineMs = Date.parse(deadline || "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / DAY_MS));
}

function importanceWeight(importance = "core") {
  return importance === "secondary" ? 1 : 2;
}

// 风险：没碰过的最危险，碰过但崩的其次，扎实的不进缺口。
function coverageRisk(coverage = "uncovered") {
  if (coverage === "uncovered") {
    return 1;
  }
  if (coverage === "shaky") {
    return 0.85;
  }
  return 0;
}

function sourceRisk(source = "jd-topic") {
  return topicSourceRisk[source] || topicSourceRisk["jd-topic"];
}

// 就绪度读数（PRODUCT：派生视图，不是新实体）。
// 覆盖率答「碰没碰」，达标度答「会不会」（重要度加权），缺口按 重要度×风险×(1/剩余天数) 排。
// deadline 可选：没定面试日时 daysLeft 为 null，紧迫度因子取中性值。
export function buildReadiness(campaign = {}, { now = new Date() } = {}) {
  const topics = Array.isArray(campaign.topics) ? campaign.topics : [];
  const daysLeft = campaign.deadline ? daysUntil(campaign.deadline, now) : null;
  const total = topics.length;
  const touched = topics.filter((topic) => topic.coverage !== "uncovered").length;
  const totalWeight = topics.reduce((sum, topic) => sum + importanceWeight(topic.importance), 0);
  const solidWeight = topics
    .filter((topic) => topic.coverage === "solid")
    .reduce((sum, topic) => sum + importanceWeight(topic.importance), 0);

  const urgency = daysLeft === null ? 1 : 1 / Math.max(daysLeft, 1);
  const gaps = topics
    .filter((topic) => topic.coverage !== "solid")
    .map((topic) => ({
      topicId: topic.id,
      topic: topic.topic,
      importance: topic.importance,
      coverage: topic.coverage,
      source: topic.source || "jd-topic",
      priority: (
        sourceRisk(topic.source)
        * importanceWeight(topic.importance)
        * coverageRisk(topic.coverage)
        * urgency
      ),
    }))
    .sort((a, b) => b.priority - a.priority);

  return {
    daysLeft,
    topicCount: total,
    coverageRate: total ? touched / total : 0,
    masteryRate: totalWeight ? solidWeight / totalWeight : 0,
    gaps,
    likelyToFail: gaps.slice(0, 3),
    disclaimer: READINESS_DISCLAIMER,
  };
}

// 简历/面经种子没有 AI 主题，按来源给一个固定主题；JD 话题没标主题就留空，前端据此降级为扁平。
const sourceThemeFallback = {
  "resume-claim": "简历声称",
  "report-seed": "面经常考",
};

function normalizeTopicList(topics = [], source = "jd-topic") {
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => {
      const resolvedSource = topic?.source || source;
      const theme = normalizeText(topic?.theme);
      return {
        topic: normalizeText(topic?.topic || topic?.title || topic),
        importance: topic?.importance === "secondary" ? "secondary" : "core",
        source: resolvedSource,
        theme: theme || sourceThemeFallback[resolvedSource] || "",
        source_id: normalizeText(topic?.source_id || topic?.sourceId),
        source_excerpt: normalizeText(topic?.source_excerpt || topic?.sourceExcerpt),
      };
    })
    .filter((topic) => topic.topic);
}

function dedupeAndRankTopics(topicGroups = []) {
  const seen = new Set();
  const ranked = [];
  for (const group of topicGroups) {
    for (const topic of group) {
      const key = normalizeText(topic.topic).toLowerCase();
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      ranked.push({
        ...topic,
        risk_rank: ranked.length,
      });
    }
  }
  return ranked;
}

function buildReportSeedTopics({ role = "", jdText = "" } = {}) {
  const seeds = selectLoopAssistSeeds({
    role,
    topics: jdText ? [jdText.slice(0, 80)] : [],
  }, undefined, { min: 0, max: 6 });
  return seeds.map((seed) => ({
    topic: seed.baseQuestion,
    importance: "core",
    source: "report-seed",
    source_id: seed.seedId || "",
    source_excerpt: seed.sourceReportText || seed.baseQuestion || "",
  }));
}

function withReadiness(campaign, now) {
  return {
    ...campaign,
    readiness: buildReadiness(campaign, { now }),
  };
}

function fallbackRescueMarkdown({ topic, question, judgment }) {
  const misses = Array.isArray(judgment?.misses) ? judgment.misses : [];
  const missedList = misses.length
    ? misses.map((miss, index) => `${index + 1}. ${miss}`).join("\n")
    : "1. 先把题目里的关键机制、边界和取舍补全。";
  return [
    `### ${topic} · 补讲`,
    "",
    `刚才这题是：${question}`,
    "",
    "你这轮还需要补齐：",
    missedList,
    "",
    "再答一次时，先用一句话给出结论，再按“机制 -> 边界 -> 取舍/例子”的顺序展开。",
  ].join("\n");
}

async function generateTopicRescue({ campaign, topic, question, judgment, proxy }) {
  const misses = Array.isArray(judgment?.misses) ? judgment.misses : [];
  const hits = Array.isArray(judgment?.hits) ? judgment.hits : [];
  try {
    const { data, traceId } = await proxy("POST", "/api/loopassist/rescue-material", {
      scope: {
        role: campaign.role,
        round: "面试冲刺",
        topics: [topic.topic],
      },
      gap: {
        topic: topic.topic,
        title: topic.topic,
        questionText: question,
        summary: "",
        misses,
        keyPoints: hits,
        likelyFollowups: [],
      },
    });
    const markdown = normalizeText(data?.markdown);
    return {
      rescue: {
        markdown: markdown || fallbackRescueMarkdown({ topic: topic.topic, question, judgment }),
        fallback: !markdown,
      },
      traceId,
    };
  } catch (error) {
    return {
      rescue: {
        markdown: fallbackRescueMarkdown({ topic: topic.topic, question, judgment }),
        fallback: true,
        reason: error instanceof Error ? error.message : String(error),
      },
      traceId: "",
    };
  }
}

export function createCampaignDomain({
  store,
  reviewItemStore,
  proxy = proxyJson,
  loadUserProfile = getUserProfile,
  loadLibraryItem = getLibraryItem,
  now = () => new Date(),
} = {}) {
  if (!store) {
    throw new Error("campaign goal store is required.");
  }
  if (!reviewItemStore) {
    throw new Error("review item store is required.");
  }

  // 主轴解析：把「贴 JD / 选库 JD / 选面经」三种来源统一成 {spineText, primaryTopics, addReportSeeds}。
  // 贴/选 JD 走 decompose-jd（话题 source=jd-topic，并自动叠加面经种子）；
  // 选面经走 decompose-interview（话题 source=report-seed，面经本身即来源，不再另叠种子）。
  async function resolveSpine({ spine, jdText, role }) {
    const cleanRole = normalizeText(role);
    let kind = normalizeText(spine?.source);
    let text = "";

    if (kind === "jd-library" || kind === "interview-library") {
      const libraryKind = kind === "interview-library" ? "interview" : "jd";
      const item = loadLibraryItem({ kind: libraryKind, id: normalizeText(spine?.libraryId) });
      if (!item) {
        throw new Error("选中的库内条目不存在，请重新选择。");
      }
      text = normalizeText(item.text);
    } else {
      // 默认 / jd-paste：直接用贴进来的 JD 文本（向后兼容旧 jdText 入参）。
      kind = "jd-paste";
      text = normalizeText(spine?.text || jdText);
    }

    if (!text) {
      throw new Error("缺少冲刺来源：贴 JD、选库内 JD 或选一篇面经其中之一。");
    }

    if (kind === "interview-library") {
      const { data, traceId } = await proxy("POST", "/api/campaign/decompose-interview", {
        reportText: text,
        role: cleanRole,
      });
      return {
        spineText: text,
        primaryTopics: normalizeTopicList(data?.topics, "report-seed"),
        addReportSeeds: false,
        traceId,
      };
    }

    const { data, traceId } = await proxy("POST", "/api/campaign/decompose-jd", {
      jdText: text,
      resumeText: "",
      role: cleanRole,
    });
    return {
      spineText: text,
      primaryTopics: normalizeTopicList(data?.topics, "jd-topic"),
      addReportSeeds: true,
      traceId,
    };
  }

  async function getCampaignOrThrow(id = "") {
    const cleanId = normalizeText(id);
    if (!cleanId) {
      throw new Error("campaign id is required.");
    }
    const campaign = await store.get(cleanId);
    if (!campaign) {
      throw new Error(`campaign not found: ${cleanId}`);
    }
    return campaign;
  }

  function getTopicOrThrow(campaign, topicId = "") {
    const topic = (campaign.topics || []).find((entry) => entry.id === topicId);
    if (!topic) {
      throw new Error(`campaign topic not found: ${topicId}`);
    }
    return topic;
  }

  // ① 立项 + ② 定范围：建 campaign Goal，主轴（JD 或面经）当场拆扁平话题（与已存简历交叉）。
  async function create({ company = "", role = "", deadline = "", jdText = "", resumeText = "", spine = null, userId = "" } = {}) {
    let resolvedResumeText = normalizeText(resumeText);
    if (!resolvedResumeText && userId) {
      try {
        const user = await loadUserProfile(userId);
        resolvedResumeText = normalizeText(getLatestResumeVersion(user.resumeLibrary)?.text);
      } catch {
        resolvedResumeText = "";
      }
    }

    const { spineText, primaryTopics, addReportSeeds, traceId } = await resolveSpine({ spine, jdText, role });

    let resumeTopics = [];
    if (resolvedResumeText) {
      const { data: resumeData } = await proxy("POST", "/api/campaign/decompose-resume", {
        resumeText: resolvedResumeText,
        role: normalizeText(role),
      });
      resumeTopics = normalizeTopicList(resumeData?.topics, "resume-claim");
    }
    const topics = dedupeAndRankTopics([
      resumeTopics,
      primaryTopics,
      addReportSeeds ? normalizeTopicList(buildReportSeedTopics({ role, jdText: spineText }), "report-seed") : [],
    ]);
    if (!topics.length) {
      throw new Error("来源拆解没有产出任何话题，请检查内容后重试。");
    }
    const campaign = await store.create({
      company,
      role,
      deadline,
      jdText: spineText,
      resumeText: resolvedResumeText,
      topics,
      now: now().toISOString(),
    });
    return { campaign: withReadiness(campaign, now()), traceId };
  }

  async function list() {
    const campaigns = await store.list();
    const current = now();
    return { campaigns: campaigns.map((campaign) => withReadiness(campaign, current)) };
  }

  async function detail({ id } = {}) {
    const campaign = await getCampaignOrThrow(id);
    return { campaign: withReadiness(campaign, now()) };
  }

  // ③ 冲刺：话题 practice 出题。种子=JD 话题（同一出题引擎，换个种子而已）。
  async function startTopicPractice({ id, topicId } = {}) {
    const campaign = await getCampaignOrThrow(id);
    const topic = getTopicOrThrow(campaign, topicId);
    const { data, traceId } = await proxy("POST", "/api/review/generate-question", {
      reviewItem: {
        id: `${campaign.id}:${topic.id}`,
        handle: topic.topic,
        state: topic.coverage === "solid" ? "solid" : "shaky",
        evidence: {},
      },
      sourceExcerpt: clipText(topic.source_excerpt || campaign.jd_text || campaign.resume_text),
    });
    const question = normalizeText(data?.question);
    if (!question) {
      throw new Error("AI 服务未能生成话题练习题，请稍后重试。");
    }
    return {
      mode: "campaign_practice",
      campaignId: campaign.id,
      topic: { id: topic.id, topic: topic.topic, importance: topic.importance, coverage: topic.coverage, source: topic.source },
      question,
      intent: data?.intent || "campaign_topic_practice",
      traceId,
    };
  }

  // ③ 冲刺：判分 → 覆盖度写 Goal；答崩 → 失败写全局账本（next_due 被 deadline 封顶）。
  // 补讲改为单独请求，避免主提交流程被生成补讲拖到前端超时。
  async function answerTopicPractice({ id, topicId, question = "", answer: learnerAnswer = "" } = {}) {
    const campaign = await getCampaignOrThrow(id);
    const topic = getTopicOrThrow(campaign, topicId);
    const cleanQuestion = normalizeText(question);
    const cleanAnswer = normalizeText(learnerAnswer);
    if (!cleanQuestion) {
      throw new Error("question is required.");
    }
    if (!cleanAnswer) {
      throw new Error("answer is required.");
    }

    const { data: judgment, traceId } = await proxy("POST", "/api/anchor-judge", {
      question: cleanQuestion,
      answer: cleanAnswer,
      sourceExcerpt: clipText(topic.source_excerpt || campaign.jd_text || campaign.resume_text),
    });
    const passed = judgment?.verdict === "pass";
    const nowIso = now().toISOString();
    const updatedCampaign = await store.updateTopicCoverage({
      id: campaign.id,
      topicId: topic.id,
      coverage: passed ? "solid" : "shaky",
      now: nowIso,
    });

    let reviewItem = null;
    if (!passed) {
      const misses = Array.isArray(judgment?.misses) ? judgment.misses : [];
      // 真实失败进全局账本（战役结束后流回日常 = 留存桥）。同 handle 已有项就更新，不重复建。
      const existing = (await reviewItemStore.list()).find((item) => item.handle === topic.topic);
      reviewItem = existing
        ? await reviewItemStore.updateState({
            id: existing.id,
            state: "shaky",
            now: nowIso,
            deadline: campaign.deadline || null,
          })
        : await reviewItemStore.recordMiss({
            handle: topic.topic,
            source_ref: "",
            evidence: { question: cleanQuestion, missedAnchors: misses },
            now: nowIso,
            deadline: campaign.deadline || null,
          });
    }

    return {
      mode: "campaign_practice",
      campaign: withReadiness(updatedCampaign, now()),
      topic: { id: topic.id, topic: topic.topic, importance: topic.importance, coverage: passed ? "solid" : "shaky", source: topic.source },
      question: cleanQuestion,
      answer: cleanAnswer,
      judgment,
      passed,
      reviewItem,
      rescue: passed ? null : { pending: true, markdown: "" },
      traceId,
    };
  }

  async function rescueTopicPractice({ id, topicId, question = "", hits = [], misses = [] } = {}) {
    const campaign = await getCampaignOrThrow(id);
    const topic = getTopicOrThrow(campaign, topicId);
    const cleanQuestion = normalizeText(question);
    if (!cleanQuestion) {
      throw new Error("question is required.");
    }
    return generateTopicRescue({
      campaign,
      topic,
      question: cleanQuestion,
      judgment: { hits, misses },
      proxy,
    });
  }

  // ⑦ 面试后回灌：真被问到却答不上的，直接转复习项（最值钱的失败，不经判分）。
  async function debrief({ id, misses = [] } = {}) {
    const campaign = await getCampaignOrThrow(id);
    const cleanMisses = (Array.isArray(misses) ? misses : [])
      .map((entry) => ({
        handle: normalizeText(entry?.handle || entry?.topic),
        question: normalizeText(entry?.question),
      }))
      .filter((entry) => entry.handle);
    if (!cleanMisses.length) {
      throw new Error("debrief needs at least one missed point.");
    }
    const nowIso = now().toISOString();
    const items = [];
    for (const miss of cleanMisses) {
      items.push(await reviewItemStore.recordMiss({
        handle: miss.handle,
        source_ref: "",
        evidence: {
          question: miss.question || `面试实战：${miss.handle}`,
          missedAnchors: [],
        },
        now: nowIso,
      }));
    }
    return { campaign: withReadiness(campaign, now()), reviewItems: items };
  }

  // ⑧ 收尾：归档 Goal，覆盖度清单随之失效；复习项留下、流回日常。
  async function archive({ id, outcome = "" } = {}) {
    const campaign = await store.archive({ id: normalizeText(id), outcome, now: now().toISOString() });
    return { campaign: withReadiness(campaign, now()) };
  }

  return {
    create,
    list,
    detail,
    startTopicPractice,
    answerTopicPractice,
    rescueTopicPractice,
    debrief,
    archive,
  };
}
