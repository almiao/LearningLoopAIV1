import { createBaselinePackDecomposition, defaultBaselinePackId, getBaselinePackById } from "../baseline/baseline-packs.js";

const reminderCategoryPriority = [
  "yesterday_gap_followup",
  "forgetting_point_review",
  "interrupted_learning_recovery",
];

function toIsoOrEmpty(value = "") {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function hoursSince(value = "") {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - date.getTime()) / (1000 * 60 * 60));
}

function buildConceptLookup(pack) {
  const decomposition = createBaselinePackDecomposition(pack);
  return {
    pack,
    decomposition,
    concepts: decomposition.concepts || [],
  };
}

function resolveTargetRecord(user) {
  const targets = Object.values(user?.targets || {});
  return targets.sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")))[0] || null;
}

function scoreCategory(category) {
  const index = reminderCategoryPriority.indexOf(category);
  return index < 0 ? reminderCategoryPriority.length : index;
}

function deriveReminderCategory({ memoryItem, targetRecord }) {
  const evidenceCount = memoryItem?.evidenceCount || 0;
  const state = memoryItem?.state || "不可判";
  const lastActivityHours = hoursSince(targetRecord?.lastActivityAt);

  if (evidenceCount > 0 && state !== "solid" && lastActivityHours <= 36) {
    return "yesterday_gap_followup";
  }
  if (evidenceCount > 0 && lastActivityHours >= 48) {
    return "forgetting_point_review";
  }
  return "interrupted_learning_recovery";
}

function buildReminderReason({ category, concept, memoryItem, targetRecord }) {
  if (category === "yesterday_gap_followup") {
    return `你最近在“${concept.title}”上还没讲稳，这次只补一个关键点就够了。`;
  }
  if (category === "forgetting_point_review") {
    return `“${concept.title}”已经到复习窗口，现在用一个快问快答把它拉回来。`;
  }
  const rawHoursAway = hoursSince(targetRecord?.lastActivityAt);
  if (!Number.isFinite(rawHoursAway)) {
    return `你最近还没建立稳定学习记录，先从“${concept.title}”这个最小切口开始。`;
  }
  const daysAway = Math.max(1, Math.round(rawHoursAway / 24) || 1);
  return `你已经中断了 ${daysAway} 天，先从“${concept.title}”这个最小切口重新开始。`;
}

function buildTaskTitle({ category, concept }) {
  if (category === "yesterday_gap_followup") {
    return `补一下 ${concept.title}`;
  }
  if (category === "forgetting_point_review") {
    return `复习一下 ${concept.title}`;
  }
  return `重新捡起 ${concept.title}`;
}

function buildEstimatedMinutes(category) {
  if (category === "yesterday_gap_followup") {
    return 5;
  }
  if (category === "forgetting_point_review") {
    return 3;
  }
  return 4;
}

function buildMaterialContext(concept) {
  return concept.remediationHint || concept.summary || concept.excerpt || "";
}

export function buildReminderCandidate({ user, memoryProfile }) {
  const targetRecord = resolveTargetRecord(user);
  const pack = targetRecord ? getBaselinePackById(targetRecord.targetBaselineId) : getBaselinePackById(defaultBaselinePackId);
  const { concepts } = buildConceptLookup(pack);

  const ranked = concepts
    .map((concept) => {
      const memoryItem = memoryProfile?.abilityItems?.[concept.id] || null;
      const category = deriveReminderCategory({ memoryItem, targetRecord });
      const evidenceCount = memoryItem?.evidenceCount || 0;
      const state = memoryItem?.state || "不可判";
      return {
        concept,
        memoryItem,
        category,
        score: [
          scoreCategory(category),
          state === "weak" ? 0 : state === "partial" ? 1 : state === "solid" ? 3 : 2,
          evidenceCount > 0 ? 0 : 1,
        ].join(":"),
      };
    })
    .sort((left, right) => left.score.localeCompare(right.score));

  const selected = ranked[0];
  if (!selected) {
    return null;
  }

  const { concept, category, memoryItem } = selected;
  return {
    userId: user.id,
    targetBaselineId: targetRecord?.targetBaselineId || pack.id,
    candidate: {
      taskId: `${user.id}:${concept.id}:${category}`,
      category,
      title: buildTaskTitle({ category, concept }),
      reason: buildReminderReason({ category, concept, memoryItem, targetRecord }),
      estimatedMinutes: buildEstimatedMinutes(category),
      conceptId: concept.id,
      conceptTitle: concept.title,
      conceptSummary: concept.summary || "",
      diagnosticQuestion: concept.diagnosticQuestion || concept.checkQuestion || "",
      materialContext: buildMaterialContext(concept),
      sourcePath: concept.javaGuideSources?.[0]?.path || "",
      sourceTitle: concept.javaGuideSources?.[0]?.title || "",
      targetTitle: pack.title,
      lastActivityAt: toIsoOrEmpty(targetRecord?.lastActivityAt),
    },
  };
}
