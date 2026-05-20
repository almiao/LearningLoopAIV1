function clampPercentage(value) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function daysSince(timestamp = "") {
  const date = new Date(timestamp || "");
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

function buildAction(kind, label, {
  autostart = false,
  passive = false,
} = {}) {
  return {
    kind,
    label,
    autostart,
    passive,
  };
}

function buildReasonWithLastActivity(baseReason, timestamp = "") {
  const value = daysSince(timestamp);
  if (value === null) {
    return baseReason;
  }
  if (value <= 0) {
    return `${baseReason} 你上次就在今天碰过它。`;
  }
  return `${baseReason} 你已经离开 ${value} 天了。`;
}

export function buildReentryPlan(document = {}) {
  const progressPercentage = clampPercentage(document.progressPercentage);
  const masteryPercentage = clampPercentage(document.masteryPercentage);
  const checkpointProgressLabel = String(document.trainingCheckpointProgressLabel || "").trim();
  const readingPreview = String(document.readingPreview || "").trim();
  const readingChapter = String(document.readingChapter || "").trim();
  const trainingUnavailable = document.trainingAvailability === "unavailable";
  const assessedConceptCount = Number(document.assessedConceptCount || 0);
  const hasTrainingEvidence = assessedConceptCount > 0 || Number(document.trainingAnswerCount || 0) > 0;

  if (document.ignored) {
    return {
      intent: "ignored_document",
      stageLabel: "已忽略",
      title: "这篇默认不进日常学习流",
      reason: "你把它标记成了忽略文档，所以系统不会主动把它放进默认推荐里。",
      primaryAction: buildAction("open-document", "打开原文 →"),
      secondaryActions: [
        buildAction("ask-document", "问这篇文档 →"),
      ],
    };
  }

  if (document.trainingStarted && !document.trainingCompleted) {
    return {
      intent: "resume_training",
      stageLabel: "继续训练",
      title: checkpointProgressLabel
        ? `先把这轮训练接上（${checkpointProgressLabel}）`
        : "先把这轮训练接上",
      reason: "你上次训练做到一半，直接恢复上下文比重新开始更省力。",
      primaryAction: buildAction("continue-training", "继续训练 →", { autostart: true }),
      secondaryActions: [
        buildAction("continue-reading", "回到原文 →"),
        buildAction("restart-training", "重新训练一轮 →", { autostart: true }),
      ],
    };
  }

  if (progressPercentage > 0 && progressPercentage < 100) {
    return {
      intent: "resume_reading",
      stageLabel: "继续阅读",
      title: `从 ${progressPercentage}% 接着读`,
      reason: readingPreview
        ? `上次停在${readingChapter ? `「${readingChapter}」` : "这段"}：${readingPreview}`
        : "正文还没读完，现在继续推进最顺，不需要重新找上下文。",
      primaryAction: buildAction("continue-reading", "继续阅读 →"),
      secondaryActions: [
        buildAction("ask-document", "问这篇文档 →"),
        buildAction("open-document", "只打开原文 →"),
      ],
    };
  }

  if (progressPercentage >= 100 && !document.trainingStarted && !document.trainingSkipped && !document.trainingCompleted) {
    if (trainingUnavailable) {
      return {
        intent: "reference_lookup",
        stageLabel: "查阅原文",
        title: "这篇更适合当参考资料",
        reason: document.trainingUnavailableReason || "正文已读完，但当前内容不足以拆成稳定训练点，更适合作为阅读和查询材料。",
        primaryAction: buildAction("ask-document", "问这篇文档 →"),
        secondaryActions: [
          buildAction("open-document", "回看原文 →"),
        ],
      };
    }
    return {
      intent: "start_training",
      stageLabel: "开始训练",
      title: "正文读完了，轮到确认会不会讲",
      reason: "如果现在不练，很容易停留在“看过了”的错觉里。直接进一轮训练最值回票价。",
      primaryAction: buildAction("start-training", "开始训练 →", { autostart: true }),
      secondaryActions: [
        buildAction("ask-document", "先问这篇文档 →"),
        buildAction("open-document", "回看原文 →"),
      ],
    };
  }

  if (document.trainingSkipped) {
    return {
      intent: "restart_training",
      stageLabel: "补上训练",
      title: "你上次按仅阅读收尾",
      reason: "如果这篇现在变重要了，补上一轮训练会比重看全文更快把理解拉实。",
      primaryAction: buildAction("restart-training", "重新开启训练 →", { autostart: true }),
      secondaryActions: [
        buildAction("open-document", "继续只读原文 →"),
        buildAction("ask-document", "先问这篇文档 →"),
      ],
    };
  }

  if (document.trainingCompleted) {
    if (hasTrainingEvidence || masteryPercentage > 0) {
      return {
        intent: "quick_review",
        stageLabel: "快速复习",
        title: "别重头来，先把关键点拉回来",
        reason: buildReasonWithLastActivity("这篇你已经学过了，这次更适合做一个短复习，而不是从第一页再刷一遍。", document.lastActivityAt),
        primaryAction: buildAction("quick-review", "快速复习 →", { autostart: true }),
        secondaryActions: [
          buildAction("restart-training", "重新训练一轮 →", { autostart: true }),
          buildAction("ask-document", "问这篇文档 →"),
        ],
      };
    }
    return {
      intent: "reference_lookup",
      stageLabel: "回看原文",
      title: "这篇已经收口，可以按需查阅",
      reason: "训练已经完成。如果这次不是来复习完整链路，就直接把它当参考资料用。",
      primaryAction: buildAction("open-document", "回看原文 →"),
      secondaryActions: [
        buildAction("ask-document", "问这篇文档 →"),
      ],
    };
  }

  return {
    intent: "start_reading",
    stageLabel: "开始阅读",
    title: "先把正文打开，建立第一轮上下文",
    reason: "这篇还没开始，先读起来，后面的训练和复习才有抓手。",
    primaryAction: buildAction("continue-reading", "开始阅读 →"),
    secondaryActions: [
      buildAction("open-document", "只打开原文 →"),
    ],
  };
}

export function isTrainingAction(action = null) {
  return [
    "continue-training",
    "start-training",
    "restart-training",
    "quick-review",
    "weak-point-review",
  ].includes(action?.kind);
}

export function isReadingAction(action = null) {
  return [
    "continue-reading",
    "open-document",
    "ask-document",
    "reference-lookup",
  ].includes(action?.kind);
}
