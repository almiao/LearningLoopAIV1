import { getLatestResumeVersion } from "../../../src/user/resume-version-store.js";
import { getUserProfile } from "./profile-domain.js";
import { proxyJson } from "./service-proxy.js";

// 面试战役域 — PRODUCT.md「面试战役」的 BFF 编排层。
//
// 守 §1.3：这里没有第二个引擎。话题 drill 复用的是与复习 drill 完全相同的三个零件
// （/api/review/generate-question 出题、/api/anchor-judge 判分、rescue-material 补讲），
// 只是种子从「复习项」换成「JD 话题」——这就是"参数化"的全部。
// 覆盖度写 Goal（per-Goal、随战役生灭），失败写账本（全局、持久）——碰过 ≠ 会。

const DAY_MS = 24 * 60 * 60 * 1000;
const jdExcerptLimit = 2400;

// 就绪度的诚实边界（PRODUCT「面试战役」就绪度节）：必须随读数一起返回，否则误导。
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
  const drill = /^\/api\/campaigns\/([^/]+)\/topics\/([^/]+)\/drill$/.exec(pathname);
  if (drill) {
    return { id: decodeURIComponent(drill[1]), action: "drill", topicId: decodeURIComponent(drill[2]) };
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
      priority: importanceWeight(topic.importance) * coverageRisk(topic.coverage) * urgency,
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

export function createCampaignDomain({
  store,
  reviewItemStore,
  proxy = proxyJson,
  loadUserProfile = getUserProfile,
  now = () => new Date(),
} = {}) {
  if (!store) {
    throw new Error("campaign goal store is required.");
  }
  if (!reviewItemStore) {
    throw new Error("review item store is required.");
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

  // ① 立项 + ② 定范围：建 campaign Goal，JD 当场拆扁平话题（与已存简历交叉）。
  async function create({ company = "", role = "", deadline = "", jdText = "", userId = "" } = {}) {
    const cleanJd = normalizeText(jdText);
    if (!cleanJd) {
      throw new Error("jdText is required.");
    }
    let resumeText = "";
    if (userId) {
      try {
        const user = await loadUserProfile(userId);
        resumeText = normalizeText(getLatestResumeVersion(user.resumeLibrary)?.text);
      } catch {
        resumeText = "";
      }
    }
    const { data, traceId } = await proxy("POST", "/api/campaign/decompose-jd", {
      jdText: cleanJd,
      resumeText,
      role: normalizeText(role),
    });
    const topics = Array.isArray(data?.topics) ? data.topics : [];
    if (!topics.length) {
      throw new Error("JD 拆解没有产出任何话题，请检查 JD 内容后重试。");
    }
    const campaign = await store.create({
      company,
      role,
      deadline,
      jdText: cleanJd,
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

  // ③ 冲刺：话题 drill 出题。种子=JD 话题（同一出题引擎，换个种子而已）。
  async function startTopicDrill({ id, topicId } = {}) {
    const campaign = await getCampaignOrThrow(id);
    const topic = getTopicOrThrow(campaign, topicId);
    const { data, traceId } = await proxy("POST", "/api/review/generate-question", {
      reviewItem: {
        id: `${campaign.id}:${topic.id}`,
        handle: topic.topic,
        state: topic.coverage === "solid" ? "solid" : "shaky",
        evidence: {},
      },
      sourceExcerpt: clipText(campaign.jd_text),
    });
    const question = normalizeText(data?.question);
    if (!question) {
      throw new Error("AI 服务未能生成话题练习题，请稍后重试。");
    }
    return {
      mode: "campaign_drill",
      campaignId: campaign.id,
      topic: { id: topic.id, topic: topic.topic, importance: topic.importance, coverage: topic.coverage },
      question,
      intent: data?.intent || "campaign_topic_drill",
      traceId,
    };
  }

  // ③ 冲刺：判分 → 覆盖度写 Goal；答崩 → 失败写全局账本（next_due 被 deadline 封顶）+ 补讲。
  async function answerTopicDrill({ id, topicId, question = "", answer: learnerAnswer = "" } = {}) {
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
      sourceExcerpt: clipText(campaign.jd_text),
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
    let rescue = null;
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

      try {
        const { data } = await proxy("POST", "/api/loopassist/rescue-material", {
          scope: {
            role: campaign.role,
            round: "面试冲刺",
            topics: [topic.topic],
          },
          gap: {
            topic: topic.topic,
            title: topic.topic,
            questionText: cleanQuestion,
            summary: "",
            misses,
            keyPoints: Array.isArray(judgment?.hits) ? judgment.hits : [],
            likelyFollowups: [],
          },
        });
        const markdown = normalizeText(data?.markdown);
        rescue = {
          markdown: markdown || fallbackRescueMarkdown({ topic: topic.topic, question: cleanQuestion, judgment }),
          fallback: !markdown,
        };
      } catch (error) {
        rescue = {
          markdown: fallbackRescueMarkdown({ topic: topic.topic, question: cleanQuestion, judgment }),
          fallback: true,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      mode: "campaign_drill",
      campaign: withReadiness(updatedCampaign, now()),
      topic: { id: topic.id, topic: topic.topic, importance: topic.importance, coverage: passed ? "solid" : "shaky" },
      question: cleanQuestion,
      answer: cleanAnswer,
      judgment,
      passed,
      reviewItem,
      rescue,
      traceId,
    };
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
    startTopicDrill,
    answerTopicDrill,
    debrief,
    archive,
  };
}
