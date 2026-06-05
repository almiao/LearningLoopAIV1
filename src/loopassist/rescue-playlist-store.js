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

function buildPlanItemId(planItem = {}, index = 0) {
  const hash = createHash("sha1")
    .update(JSON.stringify({
      title: normalizeText(planItem.title),
      reuseDocPath: normalizeText(planItem.reuseDocPath),
      questionNumbers: uniqueNumbers(planItem.questionNumbers),
    }))
    .digest("hex")
    .slice(0, 10);
  const base = slugify(planItem.title) || `item-${index + 1}`;
  return `${base}-${hash}`.slice(0, 120);
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

    async prepare({ sessionId, scope = {}, review = {}, documents = [], generatePlan } = {}) {
      const playlistId = buildPlaylistId(sessionId);
      const existing = await readExisting(playlistId);
      if (existing?.items?.length) {
        const persisted = hydratePlaylist(existing);
        await enqueueWrite(persisted);
        return persisted;
      }

      // The whole rescue plan — which gaps to cover, the titles, and whether to
      // reuse an existing library doc or generate fresh — is decided by the LLM.
      // This store only turns that plan into persisted, trackable playlist items.
      const planItems = typeof generatePlan === "function" ? safeArray(await generatePlan()) : [];

      const documentByPath = new Map(
        safeArray(documents)
          .filter((document) => normalizeText(document?.path))
          .map((document) => [normalizeText(document.path), document])
      );
      const questionTextByNumber = new Map(
        safeArray(review.questionReviews)
          .filter((item) => item && normalizeText(item.questionText))
          .map((item) => [Number(item.questionNumber), normalizeText(item.questionText)])
      );

      const now = Date.now();
      const seenIds = new Set();
      const questionItemMap = {};
      const items = planItems.map((planItem, index) => {
        const reuseDocPath = normalizeText(planItem.reuseDocPath);
        const matchedDocument = reuseDocPath ? documentByPath.get(reuseDocPath) : null;
        const source = matchedDocument
          ? "reuse"
          : (planItem.source === "checked" ? "checked" : "generate");
        const questionNumbers = uniqueNumbers(planItem.questionNumbers);
        const sourceQuestionTexts = uniqueStrings([
          ...safeArray(planItem.sourceQuestionTexts),
          ...questionNumbers.map((number) => questionTextByNumber.get(number)),
        ]);

        let id = buildPlanItemId(planItem, index);
        while (seenIds.has(id)) {
          id = `${id}-${index}`;
        }
        seenIds.add(id);
        for (const number of questionNumbers) {
          const key = String(number);
          questionItemMap[key] = (questionItemMap[key] || []).concat(id);
        }

        const docPath = matchedDocument ? normalizeText(matchedDocument.path) : "";
        return {
          id,
          source,
          title: normalizeText(planItem.title) || `补救材料 ${index + 1}`,
          topic: normalizeText(planItem.topic),
          docPath,
          summary: normalizeText(planItem.summary),
          questionNumbers,
          sourceQuestionTexts,
          misses: uniqueStrings(planItem.misses),
          keyPoints: uniqueStrings(planItem.keyPoints),
          likelyFollowups: uniqueStrings(planItem.likelyFollowups),
          priority: Number(planItem.priority) || 0,
          status: source === "reuse" ? "ready" : "gen",
          readyAt: source === "reuse" ? now : now + (sourceDelaysMs[source] || sourceDelaysMs.generate),
          learnedAt: "",
          trainingDocPath: docPath,
          scopeRole: normalizeText(scope.role),
        };
      });

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
        items,
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
