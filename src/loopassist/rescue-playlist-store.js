import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPlaylistsDir = path.resolve(__dirname, "../../.omx/loopassist-rescue-playlists");
const safePlaylistIdPattern = /^[a-zA-Z0-9:_-]{1,160}$/;
const sourceDelaysMs = {
  reuse: 0,
  generate: 1600,
  checked: 2800,
};

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

function assertSafePlaylistId(playlistId = "") {
  if (!safePlaylistIdPattern.test(String(playlistId || ""))) {
    throw new Error("Invalid rescue playlist id.");
  }
}

function buildPlaylistId(sessionId = "") {
  const normalized = normalizeText(sessionId);
  if (!normalized) {
    throw new Error("sessionId is required.");
  }
  return `loopassist-rescue-${normalized.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueNumbers(values = []) {
  return Array.from(
    new Set(
      safeArray(values)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  ).sort((left, right) => left - right);
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      safeArray(values)
        .map((value) => normalizeText(value))
        .filter(Boolean)
    )
  );
}

function inferSourceMode(question = {}) {
  const haystack = [
    question.topic,
    question.questionText,
    ...(question.misses || []),
    ...(question.keyPoints || []),
  ].join(" ");
  if (/(mysql|redis|mq|消息队列|kafka|rabbitmq|rocketmq|redisson|索引|sql|grpc|rest|ttl|缓存|锁)/i.test(haystack)) {
    return "checked";
  }
  return "generate";
}

function scoreQuestionPriority(question = {}) {
  const statusWeight = question.status === "miss" ? 100 : question.status === "warn" ? 60 : 10;
  const numericScore = Number(question.score);
  const penalty = Number.isFinite(numericScore) ? Math.max(0, 100 - numericScore) : 35;
  return statusWeight + penalty;
}

function extractKeywords(question = {}) {
  const values = [
    question.topic,
    question.questionText,
    ...(question.misses || []),
    ...(question.keyPoints || []),
  ]
    .join(" ")
    .toLowerCase();
  const keywords = [];
  if (/hashmap/.test(values)) {
    keywords.push("hashmap");
  }
  if (/synchronized/.test(values)) {
    keywords.push("synchronized");
  }
  if (/redis/.test(values)) {
    keywords.push("redis");
  }
  if (/(消息队列|mq|kafka|rabbitmq|rocketmq)/.test(values)) {
    keywords.push("message-queue");
  }
  if (/(mysql|索引|sql)/.test(values)) {
    keywords.push("mysql-index");
  }
  if (/(锁|redisson|setnx)/.test(values)) {
    keywords.push("distributed-lock");
  }
  if (/(ttl|缓存)/.test(values)) {
    keywords.push("cache");
  }
  if (/(并发|juc|monitor|mark word)/.test(values)) {
    keywords.push("java-concurrent");
  }
  return keywords;
}

function matchExistingDocument(question = {}, documents = []) {
  const keywords = extractKeywords(question);
  if (!keywords.length) {
    return null;
  }
  const docList = safeArray(documents).map((document) => ({
    ...document,
    searchText: `${document.title || ""} ${document.path || ""}`.toLowerCase(),
  }));
  const candidates = [
    {
      keyword: "hashmap",
      test: (doc) => /hashmap/.test(doc.searchText),
    },
    {
      keyword: "synchronized",
      test: (doc) => /synchronized|并发常见面试题/.test(doc.searchText),
    },
    {
      keyword: "redis",
      test: (doc) => /redis常见面试题总结|缓存基础常见面试题总结|redis-stream-mq/.test(doc.searchText),
    },
    {
      keyword: "message-queue",
      test: (doc) => /消息队列基础知识总结|redis-stream-mq|rabbitmq常见问题总结|rocketmq常见问题总结/.test(doc.searchText),
    },
    {
      keyword: "mysql-index",
      test: (doc) => /mysql索引详解|mysql执行计划分析|sql语句在mysql中的执行过程/.test(doc.searchText),
    },
    {
      keyword: "distributed-lock",
      test: (doc) => /分布式锁常见实现方案总结|分布式锁入门介绍/.test(doc.searchText),
    },
    {
      keyword: "cache",
      test: (doc) => /缓存基础常见面试题总结|缓存读写策略/.test(doc.searchText),
    },
    {
      keyword: "java-concurrent",
      test: (doc) => /java并发常见面试题总结|java 常见并发容器总结/.test(doc.searchText),
    },
  ];
  for (const candidate of candidates) {
    if (!keywords.includes(candidate.keyword)) {
      continue;
    }
    const matched = docList.find(candidate.test);
    if (matched) {
      return matched;
    }
  }
  return null;
}

function getFallbackTrainingDocPath(question = {}, documents = []) {
  const matched = matchExistingDocument(question, documents);
  if (matched?.path) {
    return matched.path;
  }
  const keywords = extractKeywords(question);
  const fallbackCandidates = [];
  if (keywords.includes("hashmap")) {
    fallbackCandidates.push("docs/java/collection/hashmap-source-code.md");
  }
  if (keywords.includes("java-concurrent") || keywords.includes("synchronized")) {
    fallbackCandidates.push("docs/java/concurrent/java-concurrent-questions-01.md");
  }
  if (keywords.includes("mysql-index")) {
    fallbackCandidates.push("docs/database/mysql/mysql-index.md");
  }
  if (keywords.includes("message-queue")) {
    fallbackCandidates.push("docs/high-performance/message-queue/message-queue.md");
  }
  if (keywords.includes("distributed-lock")) {
    fallbackCandidates.push("docs/distributed-system/distributed-lock-implementations.md");
  }
  if (keywords.includes("cache")) {
    fallbackCandidates.push("docs/database/redis/cache-basics.md");
  }
  if (keywords.includes("redis")) {
    fallbackCandidates.push("docs/database/redis/redis-questions-01.md");
  }
  const existingPaths = new Set(safeArray(documents).map((item) => item.path));
  return fallbackCandidates.find((candidate) => existingPaths.has(candidate)) || safeArray(documents)[0]?.path || "";
}

function buildSyntheticDocument(playlist = {}, item = {}, documentPath = "") {
  const markdown = normalizeText(item.materialMarkdown);
  if (!markdown) {
    throw new Error("Rescue material has not been generated yet.");
  }
  return {
    path: documentPath || `rescue://${playlist.id}/${item.id}`,
    title: item.title || "补救材料",
    primaryFormat: "markdown",
    render: {
      format: "markdown",
      defaultView: "learning",
      previewable: false,
    },
    learning: {
      markdown,
      text: markdown,
      outline: markdown
        .split("\n")
        .map((line) => line.match(/^(#{1,4})\s+(.*)$/))
        .filter(Boolean)
        .map((match) => ({
          level: Math.min(match[1].length, 4),
          label: match[2].trim(),
          id: slugify(match[2].trim()),
        })),
    },
    originalSource: {
      providerLabel: "LoopAssist Rescue",
      url: "",
    },
  };
}

function buildMaterialCacheKey(question = {}, suffix = "") {
  const hash = createHash("sha1")
    .update(JSON.stringify({
      topic: question.topic || "",
      questionText: question.questionText || "",
      misses: safeArray(question.misses).slice(0, 4),
      keyPoints: safeArray(question.keyPoints).slice(0, 4),
      suffix,
    }))
    .digest("hex")
    .slice(0, 12);
  return `${slugify(question.topic || question.questionText || "rescue") || "rescue"}-${suffix || "main"}-${hash}`;
}

function buildGeneratedTitle(question = {}, mode = "generate") {
  const topic = normalizeText(question.topic) || "这块知识";
  const seed = normalizeText(question.questionText || "");
  if (/hashmap/i.test(seed)) {
    return "HashMap 底层与面试表达拆解";
  }
  if (/synchronized/i.test(seed)) {
    return "synchronized 原理与锁升级";
  }
  if (/(mysql|索引|sql)/i.test(seed)) {
    return "MySQL 索引执行路径拆解";
  }
  if (/(mq|消息队列|kafka|rabbitmq|rocketmq|stream)/i.test(seed)) {
    return "消息队列选型与追问拆解";
  }
  if (/(锁|redisson|setnx)/i.test(seed)) {
    return "分布式锁取舍与 Redisson 价值";
  }
  if (/(ttl|缓存)/i.test(seed)) {
    return "TTL 缓存设计与边界处理";
  }
  return mode === "checked" ? `${topic} · 核对版讲解` : `${topic} · 面试补救讲解`;
}

function mergeQuestionIntoItem(item, question) {
  item.questionNumbers = uniqueNumbers((item.questionNumbers || []).concat([question.questionNumber]));
  item.sourceQuestionTexts = uniqueStrings((item.sourceQuestionTexts || []).concat([question.questionText]));
  item.misses = uniqueStrings((item.misses || []).concat(question.misses || []));
  item.keyPoints = uniqueStrings((item.keyPoints || []).concat(question.keyPoints || []));
  item.likelyFollowups = uniqueStrings((item.likelyFollowups || []).concat(question.likelyFollowups || []));
  const summaries = uniqueStrings([item.summary, question.performanceSummary].filter(Boolean));
  item.summary = summaries[0] || item.summary || "";
  item.priority = Math.max(Number(item.priority || 0), scoreQuestionPriority(question));
}

function buildCandidateItems(question = {}, documents = []) {
  const candidates = [];
  const matchedDocument = matchExistingDocument(question, documents);
  if (matchedDocument) {
    candidates.push({
      id: `reuse-${slugify(matchedDocument.path || matchedDocument.title)}`,
      cacheKey: `reuse:${matchedDocument.path}`,
      title: matchedDocument.title || buildGeneratedTitle(question, "reuse"),
      topic: normalizeText(question.topic),
      source: "reuse",
      docPath: matchedDocument.path || "",
      summary: normalizeText(question.performanceSummary) || normalizeText(question.coachingTip) || "这篇现成材料能直接补上当前缺口。",
      questionNumbers: [question.questionNumber],
      sourceQuestionTexts: [question.questionText],
      misses: safeArray(question.misses),
      keyPoints: safeArray(question.keyPoints),
      likelyFollowups: safeArray(question.likelyFollowups),
      priority: scoreQuestionPriority(question) + 8,
      trainingDocPath: matchedDocument.path || "",
    });
  }

  const mode = inferSourceMode(question);
  const shouldAddSupplement = !matchedDocument || question.status === "miss";
  if (shouldAddSupplement) {
    candidates.push({
      id: `${mode}-${buildMaterialCacheKey(question, matchedDocument ? "supplement" : "main")}`,
      cacheKey: `${mode}:${buildMaterialCacheKey(question, matchedDocument ? "supplement" : "main")}`,
      title: matchedDocument ? `${normalizeText(question.topic) || "这块"} · 面试回答拆解` : buildGeneratedTitle(question, mode),
      topic: normalizeText(question.topic),
      source: mode,
      docPath: "",
      summary: normalizeText(question.coachingTip) || normalizeText(question.performanceSummary) || "系统会补一份更贴近这道题的讲解与答法。",
      questionNumbers: [question.questionNumber],
      sourceQuestionTexts: [question.questionText],
      misses: safeArray(question.misses),
      keyPoints: safeArray(question.keyPoints),
      likelyFollowups: safeArray(question.likelyFollowups),
      priority: scoreQuestionPriority(question),
      trainingDocPath: getFallbackTrainingDocPath(question, documents),
    });
  }
  return candidates;
}

function normalizeItemStatus(item = {}) {
  if (item.source === "reuse") {
    return item.status === "learned" ? "learned" : "ready";
  }
  if (item.status === "learned") {
    return "learned";
  }
  if (item.status === "ready" || item.status === "gen" || item.status === "pending") {
    return item.status;
  }
  return "pending";
}

function hydratePlaylist(playlist = {}) {
  const now = Date.now();
  const items = safeArray(playlist.items).map((item) => {
    const nextItem = {
      ...item,
      questionNumbers: uniqueNumbers(item.questionNumbers),
      sourceQuestionTexts: uniqueStrings(item.sourceQuestionTexts),
      misses: uniqueStrings(item.misses),
      keyPoints: uniqueStrings(item.keyPoints),
      likelyFollowups: uniqueStrings(item.likelyFollowups),
      summary: normalizeText(item.summary),
      status: normalizeItemStatus(item),
    };
    if (nextItem.source !== "reuse" && nextItem.status !== "learned") {
      const readyAt = Number(nextItem.readyAt || 0);
      if (readyAt > 0 && now >= readyAt) {
        nextItem.status = "ready";
      } else if (nextItem.status === "pending") {
        nextItem.status = "gen";
      }
    }
    return nextItem;
  }).sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0));
  const readyCount = items.filter((item) => item.status === "ready" || item.status === "learned").length;
  const learnedCount = items.filter((item) => item.status === "learned").length;
  const firstReadyItemId = items.find((item) => item.status === "ready" || item.status === "learned")?.id || "";
  return {
    ...playlist,
    items,
    totalCount: items.length,
    readyCount,
    learnedCount,
    remainingCount: items.filter((item) => item.status !== "learned").length,
    firstReadyItemId,
    completed: items.length > 0 && learnedCount === items.length,
    updatedAt: new Date().toISOString(),
  };
}

export function createLoopAssistRescuePlaylistStore({ playlistsDir = defaultPlaylistsDir } = {}) {
  const writeQueues = new Map();

  async function ensureDir() {
    await mkdir(playlistsDir, { recursive: true });
  }

  function getPlaylistPath(playlistId) {
    assertSafePlaylistId(playlistId);
    return path.join(playlistsDir, `${playlistId}.json`);
  }

  async function writePlaylistAtomically(playlist) {
    const playlistPath = getPlaylistPath(playlist.id);
    const tempPath = `${playlistPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(playlist, null, 2)}\n`, "utf8");
      await rename(tempPath, playlistPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function enqueueWrite(playlist) {
    const previous = writeQueues.get(playlist.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => writePlaylistAtomically(playlist));
    writeQueues.set(playlist.id, next);
    try {
      await next;
    } finally {
      if (writeQueues.get(playlist.id) === next) {
        writeQueues.delete(playlist.id);
      }
    }
  }

  async function readExisting(playlistId) {
    await ensureDir();
    try {
      const raw = await readFile(getPlaylistPath(playlistId), "utf8");
      return hydratePlaylist(JSON.parse(raw));
    } catch (error) {
      if (String(error?.code || "") === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  return {
    async list() {
      await ensureDir();
      const entries = await readdir(playlistsDir, { withFileTypes: true });
      const playlists = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        try {
          const raw = await readFile(path.join(playlistsDir, entry.name), "utf8");
          playlists.push(hydratePlaylist(JSON.parse(raw)));
        } catch {}
      }
      return playlists;
    },

    async prepare({ sessionId, scope = {}, review = {}, documents = [] } = {}) {
      const playlistId = buildPlaylistId(sessionId);
      const existing = await readExisting(playlistId);
      if (existing?.items?.length) {
        const persisted = hydratePlaylist(existing);
        await enqueueWrite(persisted);
        return persisted;
      }

      const questionReviews = safeArray(review.questionReviews)
        .filter((item) => item && item.status !== "good")
        .sort((left, right) => scoreQuestionPriority(right) - scoreQuestionPriority(left));

      const itemMap = new Map();
      const questionItemMap = {};
      for (const question of questionReviews) {
        const candidates = buildCandidateItems(question, documents);
        questionItemMap[String(question.questionNumber || "")] = [];
        for (const candidate of candidates) {
          const key = candidate.docPath ? `doc:${candidate.docPath}` : candidate.cacheKey;
          const existingItem = itemMap.get(key);
          if (existingItem) {
            mergeQuestionIntoItem(existingItem, question);
            questionItemMap[String(question.questionNumber || "")].push(existingItem.id);
            continue;
          }
          const source = candidate.source;
          const now = Date.now();
          const item = {
            ...candidate,
            source,
            priority: Number(candidate.priority || 0),
            questionNumbers: uniqueNumbers(candidate.questionNumbers),
            sourceQuestionTexts: uniqueStrings(candidate.sourceQuestionTexts),
            misses: uniqueStrings(candidate.misses),
            keyPoints: uniqueStrings(candidate.keyPoints),
            likelyFollowups: uniqueStrings(candidate.likelyFollowups),
            status: source === "reuse" ? "ready" : "gen",
            readyAt: source === "reuse" ? now : now + sourceDelaysMs[source],
            learnedAt: "",
            scopeRole: normalizeText(scope.role),
          };
          itemMap.set(key, item);
          questionItemMap[String(question.questionNumber || "")].push(item.id);
        }
      }

      const playlist = hydratePlaylist({
        id: playlistId,
        sessionId: normalizeText(sessionId),
        scope: {
          role: normalizeText(scope.role),
          round: normalizeText(scope.round),
        },
        reviewSummary: normalizeText(review.summary),
        createdAt: new Date().toISOString(),
        questionItemMap,
        items: Array.from(itemMap.values()),
      });
      await ensureDir();
      await enqueueWrite(playlist);
      return playlist;
    },

    async get(playlistId) {
      const playlist = await readExisting(playlistId);
      if (!playlist) {
        throw new Error("Rescue playlist not found.");
      }
      await enqueueWrite(playlist);
      return playlist;
    },

    async markLearned({ playlistId, itemId } = {}) {
      const playlist = await readExisting(playlistId);
      if (!playlist) {
        throw new Error("Rescue playlist not found.");
      }
      const items = playlist.items.map((item) => (
        item.id === itemId
          ? {
              ...item,
              status: "learned",
              learnedAt: item.learnedAt || new Date().toISOString(),
            }
          : item
      ));
      const nextPlaylist = hydratePlaylist({
        ...playlist,
        items,
      });
      await enqueueWrite(nextPlaylist);
      return nextPlaylist;
    },

    async saveMaterial({ playlistId, itemId, markdown } = {}) {
      const playlist = await readExisting(playlistId);
      if (!playlist) {
        throw new Error("Rescue playlist not found.");
      }
      const text = normalizeText(markdown);
      const items = playlist.items.map((item) => (
        item.id === itemId ? { ...item, materialMarkdown: text } : item
      ));
      const nextPlaylist = hydratePlaylist({ ...playlist, items });
      await enqueueWrite(nextPlaylist);
      return nextPlaylist;
    },

    async buildDocumentPayload({ playlistId, itemId } = {}) {
      const playlist = await this.get(playlistId);
      const item = playlist.items.find((entry) => entry.id === itemId);
      if (!item) {
        throw new Error("Rescue playlist item not found.");
      }
      if (!(item.status === "ready" || item.status === "learned")) {
        throw new Error("Rescue playlist item is still generating.");
      }
      const needsMaterial = !item.docPath && !normalizeText(item.materialMarkdown);
      return {
        playlist,
        item,
        needsMaterial,
        documentPath: item.docPath || item.trainingDocPath || `rescue://${playlist.id}/${item.id}`,
        document: item.docPath || needsMaterial ? null : buildSyntheticDocument(
          playlist,
          item,
          item.trainingDocPath || `rescue://${playlist.id}/${item.id}`,
        ),
      };
    },
  };
}
