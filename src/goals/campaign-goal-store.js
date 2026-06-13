import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 面试冲刺 Goal — PRODUCT.md 的持久实体 ①（另一个是复习项账本）。
//
// 纪律（落在代码里，不只在文档里）：
//   - Goal 由用户声明、数量就几个，不从内容自动抽 → 无去重负担。
//   - 覆盖度清单是 Goal 的属性（per-Goal、随战役生灭、用完即弃），不是第三个知识实体；
//     它答「碰过没」，账本答「会不会」——碰过 ≠ 会（PRODUCT「面试冲刺」关键承接 2）。
//   - 收尾归档时清单随 Goal 一起死；复习项本就全局，自动流回日常（留存桥 ⑧）。
//   - 零自有引擎：这里只有状态，practice 永远走共享操练引擎（§1.3）。

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultGoalsDir = path.resolve(__dirname, "../../.omx/goals");
const GOALS_FILE = "campaigns.json";
const GOALS_VERSION = 1;

// 覆盖度三态：未覆盖（没碰过）/ 生疏（碰过但最近一次答崩）/ 扎实（碰过且最近一次过线）。
const VALID_COVERAGE = new Set(["uncovered", "shaky", "solid"]);
const VALID_IMPORTANCE = new Set(["core", "secondary"]);
const VALID_SOURCE = new Set(["jd-topic", "resume-claim", "report-seed"]);

function normalizeText(value = "") {
  return String(value || "").trim();
}

function slugify(value = "") {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function nowIso() {
  return new Date().toISOString();
}

function buildId(seed) {
  const hash = createHash("sha1")
    .update(`${seed}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 10);
  return `${slugify(seed) || "campaign"}-${hash}`.slice(0, 120);
}

function normalizeTopic(topic = {}, index = 0) {
  const text = normalizeText(topic.topic || topic.title);
  const source = normalizeText(topic.source) || "jd-topic";
  return {
    id: normalizeText(topic.id) || `topic-${index + 1}`,
    topic: text,
    importance: VALID_IMPORTANCE.has(topic.importance) ? topic.importance : "core",
    coverage: VALID_COVERAGE.has(topic.coverage) ? topic.coverage : "uncovered",
    source: VALID_SOURCE.has(source) ? source : "jd-topic",
    // 主题为自由文本（来自 AI 拆题或来源兜底），仅做长度封顶；缺失留空 → 前端降级为扁平。
    theme: normalizeText(topic.theme).slice(0, 12),
    source_id: normalizeText(topic.source_id || topic.sourceId),
    source_excerpt: normalizeText(topic.source_excerpt || topic.sourceExcerpt),
    risk_rank: Number.isFinite(Number(topic.risk_rank || topic.riskRank)) ? Number(topic.risk_rank || topic.riskRank) : index,
    last_practiced_at: normalizeText(topic.last_practiced_at),
  };
}

function normalizeCampaign(campaign = {}) {
  const created = campaign.created_at || nowIso();
  const topics = (Array.isArray(campaign.topics) ? campaign.topics : [])
    .map((topic, index) => normalizeTopic(topic, index))
    .filter((topic) => topic.topic);
  return {
    id: normalizeText(campaign.id),
    company: normalizeText(campaign.company),
    role: normalizeText(campaign.role),
    // 面试日（deadline）：调度封顶与倒计时都从它派生。
    deadline: normalizeText(campaign.deadline),
    jd_text: String(campaign.jd_text || ""),
    resume_text: String(campaign.resume_text || ""),
    topics,
    created_at: created,
    archived_at: normalizeText(campaign.archived_at),
    outcome: normalizeText(campaign.outcome),
  };
}

export function createCampaignGoalStore({ goalsDir = defaultGoalsDir } = {}) {
  const goalsPath = path.join(goalsDir, GOALS_FILE);
  // 串行化 read-modify-write，避免并发写互相覆盖（沿用账本 store 的做法）。
  let writeChain = Promise.resolve();

  async function readCampaigns() {
    try {
      const raw = await readFile(goalsPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.campaigns) ? parsed.campaigns.map(normalizeCampaign) : [];
    } catch (error) {
      if (String(error?.code || "") === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async function writeCampaignsAtomically(campaigns) {
    await mkdir(goalsDir, { recursive: true });
    const tempPath = `${goalsPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = { version: GOALS_VERSION, updated_at: nowIso(), campaigns };
    try {
      await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tempPath, goalsPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  function mutate(apply) {
    const next = writeChain.catch(() => {}).then(async () => {
      const campaigns = await readCampaigns();
      return apply(campaigns);
    });
    writeChain = next.catch(() => {});
    return next;
  }

  return {
    async list({ includeArchived = false } = {}) {
      const campaigns = await readCampaigns();
      return includeArchived ? campaigns : campaigns.filter((campaign) => !campaign.archived_at);
    },

    async get(id) {
      const campaigns = await readCampaigns();
      return campaigns.find((campaign) => campaign.id === id) || null;
    },

    // deadline 可选：没定面试日也能先开练；定了之后调度才会被它封顶。
    async create({ company = "", role = "", deadline = "", jdText = "", resumeText = "", topics = [], now = nowIso() } = {}) {
      const cleanRole = normalizeText(role);
      const cleanDeadline = normalizeText(deadline);
      if (!cleanRole) {
        throw new Error("campaign role is required.");
      }
      if (cleanDeadline && !Number.isFinite(Date.parse(cleanDeadline))) {
        throw new Error("campaign deadline must be a valid date.");
      }
      const cleanTopics = topics
        .map((topic, index) => normalizeTopic({
          ...(typeof topic === "object" && topic !== null ? topic : { topic }),
          id: `topic-${index + 1}`,
        }, index))
        .filter((topic) => topic.topic);
      if (!cleanTopics.length) {
        throw new Error("campaign needs at least one topic.");
      }
      return mutate(async (campaigns) => {
        const campaign = normalizeCampaign({
          id: buildId(`${normalizeText(company)}-${cleanRole}`),
          company,
          role: cleanRole,
          deadline: cleanDeadline,
          jd_text: jdText,
          resume_text: resumeText,
          topics: cleanTopics,
          created_at: now,
        });
        await writeCampaignsAtomically([...campaigns, campaign]);
        return campaign;
      });
    },

    // 操练回写覆盖度：过线 → solid，答崩 → shaky（碰过即非 uncovered）。
    async updateTopicCoverage({ id, topicId, coverage, now = nowIso() } = {}) {
      if (!VALID_COVERAGE.has(coverage)) {
        throw new Error(`invalid topic coverage: ${coverage}`);
      }
      return mutate(async (campaigns) => {
        let updated = null;
        const nextCampaigns = campaigns.map((campaign) => {
          if (campaign.id !== id) {
            return campaign;
          }
          let topicFound = false;
          const topics = campaign.topics.map((topic) => {
            if (topic.id !== topicId) {
              return topic;
            }
            topicFound = true;
            return { ...topic, coverage, last_practiced_at: now };
          });
          if (!topicFound) {
            throw new Error(`campaign topic not found: ${topicId}`);
          }
          updated = { ...campaign, topics };
          return updated;
        });
        if (!updated) {
          throw new Error(`campaign not found: ${id}`);
        }
        await writeCampaignsAtomically(nextCampaigns);
        return updated;
      });
    },

    // 收尾（⑧）：归档 Goal、覆盖度清单随之失效；复习项不动（全局，流回日常）。
    async archive({ id, outcome = "", now = nowIso() } = {}) {
      return mutate(async (campaigns) => {
        let updated = null;
        const nextCampaigns = campaigns.map((campaign) => {
          if (campaign.id !== id) {
            return campaign;
          }
          updated = { ...campaign, archived_at: now, outcome: normalizeText(outcome) };
          return updated;
        });
        if (!updated) {
          throw new Error(`campaign not found: ${id}`);
        }
        await writeCampaignsAtomically(nextCampaigns);
        return updated;
      });
    },
  };
}
