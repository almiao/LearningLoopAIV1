import { generateInitialProbe } from "../material/concept-decomposer.js";

function keywordHits(answer, keywords) {
  const lowered = String(answer ?? "").toLowerCase();
  return keywords.filter((keyword) => lowered.includes(keyword)).length;
}

export function analyzeLearnerAnswer({ concept, answer }) {
  const hits = keywordHits(answer, concept.keywords);
  const normalizedAnswer = String(answer ?? "").trim();

  if (!normalizedAnswer) {
    return {
      signal: "noise",
      strength: 0,
      explanation: "没有形成可判断的回答。"
    };
  }

  if (hits >= 2 || normalizedAnswer.length > 160) {
    return {
      signal: "positive",
      strength: Math.min(1, 0.4 + hits * 0.2),
      explanation: "回答覆盖了多个关键点，具备进一步确认的基础。"
    };
  }

  if (hits === 1 || normalizedAnswer.length > 70) {
    return {
      signal: "negative",
      strength: 0.45,
      explanation: "回答触及了一部分概念，但解释还不稳定。"
    };
  }

  return {
    signal: "noise",
    strength: 0.1,
    explanation: "回答过短或与材料关键点关联不足。"
  };
}

function buildGapLabel({ concept, analysis, noiseDetected }) {
  if (noiseDetected) {
    return `回答还停留在泛化表述，没有真正落到“${concept.title}”的具体机制。`;
  }

  if (analysis.signal === "negative") {
    return `已经碰到了一部分关键词，但还没有把“${concept.title}”讲成完整、可判断的机制链路。`;
  }

  return `已经覆盖当前单元的核心点，可以继续往边界条件和反例推进。`;
}

function buildAnswerFrame(concept) {
  return `先别展开全部，直接用你自己的话说清：${concept.title} 最关键的机制是什么？`;
}

export function buildTutorFeedback({ concept, analysis, noiseDetected }) {
  const gap = buildGapLabel({ concept, analysis, noiseDetected });
  const evidenceReference = concept.excerpt || concept.summary;
  const nextQuestion = createFollowUpQuestion({ concept, lastSignal: analysis.signal });

  if (!noiseDetected && analysis.signal === "positive") {
    return {
      gap,
      evidenceReference,
      coachingStep: nextQuestion,
      positiveConfirmation: `你已经抓住了“${concept.title}”里最关键的点。`,
      enrichment: nextQuestion,
      teachingChunk: "",
      checkQuestion: nextQuestion,
      explanation: `这轮回答已经覆盖到关键点。材料证据：${evidenceReference}`
    };
  }

  const answerFrame = buildAnswerFrame(concept);
  return {
    gap,
    evidenceReference,
    coachingStep: answerFrame,
    positiveConfirmation: "",
    enrichment: "",
    teachingChunk: concept.summary || evidenceReference,
    checkQuestion: nextQuestion || answerFrame,
    explanation:
      `这题目前还没答到位。缺口：${gap} ` +
      `材料证据：${evidenceReference} ` +
      `可以先按这个骨架回答：${answerFrame}`
  };
}

export function createFollowUpQuestion({
  concept,
  lastSignal,
  burdenSignal = "normal",
  attempts = 0,
  rememberedState = "",
  revisit = false
}) {
  if (revisit) {
    return `我们回到“${concept.title}”。先别背定义，用你自己的话补上上次没讲稳的关键机制。`;
  }

  if (burdenSignal === "high") {
    return `我们先收窄一个点：${concept.title} 最关键的一环到底是什么？`;
  }

  if (lastSignal === "positive") {
    return `如果面试官继续追问边界，你会怎么解释“${concept.title}”最容易答偏的地方？`;
  }

  if (rememberedState === "partial" || attempts > 0) {
    return `结合你刚才的阅读和已有回答，再讲一次：“${concept.title}”这条链路里最容易漏掉的关键一步是什么？`;
  }

  return `不要背定义，直接用自己的话解释：“${concept.title}”最核心的机制是什么，它为什么重要？`;
}

export function chooseNextConcept(session) {
  const next = session.concepts.find((concept) => {
    const conceptSession = session.conceptStates[concept.id];
    return !conceptSession.completed;
  });

  return next || session.concepts[0];
}

export function createInitialProbe(concept, session = null) {
  const conceptState = session?.conceptStates?.[concept?.id] || null;
  const rememberedState = session?.memoryProfile?.abilityItems?.[concept?.id]?.state || "";
  if (concept?.interviewAnchor?.prompt) {
    return concept.interviewAnchor.prompt;
  }

  if (conceptState || rememberedState) {
    return createFollowUpQuestion({
      concept,
      lastSignal: rememberedState === "solid" ? "positive" : "negative",
      burdenSignal: session?.burdenSignal || "normal",
      attempts: conceptState?.attempts || 0,
      rememberedState
    });
  }

  if (concept?.interviewAnchor?.prompt) {
    return concept.interviewAnchor.prompt;
  }

  return generateInitialProbe(concept);
}
