import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppService } from "../../src/app-service.js";
import { createHeuristicTutorIntelligence } from "../../src/tutor/tutor-intelligence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_PHRASES = [
  "你的方向不算离谱",
  "我们先收窄到一个点",
  "这一点你已经抓到主要方向了",
  "我先把这一层讲清楚",
  "好，我先不让你继续猜了",
  "别在这里卡太久"
];

function compactConcept(concept) {
  return {
    id: concept.id,
    title: concept.title,
    summary: concept.summary,
    retryQuestion: concept.retryQuestion,
    checkQuestion: concept.checkQuestion,
    stretchQuestion: concept.stretchQuestion
  };
}

function compactSession(session) {
  return {
    sourceTitle: session.source.title,
    currentConceptId: session.currentConceptId,
    currentProbe: session.currentProbe,
    concepts: (session.concepts || []).map(compactConcept),
    masteryMap: session.masteryMap,
    nextSteps: session.nextSteps,
    revisitQueue: session.revisitQueue,
    interactionPreference: session.interactionPreference
  };
}

function getControlIntent(answer) {
  const normalized = String(answer || "").trim();
  if (!normalized) {
    return "empty";
  }
  if (normalized === "讲一下") {
    return "teach";
  }
  if (normalized === "下一题") {
    return "skip";
  }
  if (normalized === "总结一下") {
    return "summarize";
  }
  if (/不知道|不太清楚|不会/.test(normalized)) {
    return "unknown";
  }
  return "answer";
}

function countTemplatePhraseHits(steps) {
  return steps.reduce(
    (total, step) =>
      total +
      TEMPLATE_PHRASES.reduce((hits, phrase) => hits + (step.tutorReply.includes(phrase) ? 1 : 0), 0),
    0
  );
}

function countRepeatedTeachLoops(steps) {
  let loops = 0;
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1];
    const current = steps[index];
    if (
      previous.tutorAction === "teach" &&
      current.tutorAction === "teach" &&
      previous.conceptId === current.conceptId
    ) {
      loops += 1;
    }
  }
  return loops;
}

function buildControlResolutionMetrics(steps) {
  const intents = steps
    .map((step) => ({
      controlIntent: step.controlIntent,
      tutorAction: step.tutorAction,
      revisitQueueSize: step.revisitQueueSize
    }))
    .filter((step) => step.controlIntent !== "answer");

  return {
    totalControlTurns: intents.length,
    teachIntentHandled: intents.filter(
      (step) => step.controlIntent === "teach" && step.tutorAction === "teach"
    ).length,
    skipIntentHandled: intents.filter(
      (step) => step.controlIntent === "skip" && step.tutorAction === "advance"
    ).length,
    unknownHandledWithTeach: intents.filter(
      (step) => step.controlIntent === "unknown" && step.tutorAction === "teach"
    ).length
  };
}

function scoreKnowledgeClosure(steps) {
  const last = steps.at(-1);
  if (!last) {
    return 0;
  }
  if (last.tutorTakeaway && /关键|核心|总结|记住|结论/.test(`${last.tutorReply} ${last.tutorTakeaway}`)) {
    return 2;
  }
  if (last.tutorTakeaway) {
    return 1;
  }
  return 0;
}

function scoreTeachQuality(steps) {
  const teachSteps = steps.filter((step) => step.tutorAction === "teach");
  if (!teachSteps.length) {
    return 1;
  }
  const strongTeach = teachSteps.some(
    (step) =>
      step.tutorReply.length >= 60 &&
      (step.tutorReply.includes("ThreadLocalMap") ||
        step.tutorReply.includes("半成品对象") ||
        step.tutorReply.includes("next-key lock") ||
        step.tutorReply.includes("CLH") ||
        step.tutorTakeaway.length >= 20)
  );
  return strongTeach ? 2 : 1;
}

function scoreConversationEfficiency(steps) {
  const repeatedTeachLoops = countRepeatedTeachLoops(steps);
  if (steps.length <= 2 && repeatedTeachLoops === 0) {
    return 2;
  }
  if (steps.length <= 3 && repeatedTeachLoops <= 1) {
    return 1;
  }
  return 0;
}

function scoreConfirmationQuality(steps) {
  const confirmationHits = steps.filter((step) =>
    /抓住|方向是对的|对了一半|已经碰到|接近/.test(`${step.tutorReply} ${step.tutorStrength}`)
  ).length;
  if (confirmationHits >= 2) {
    return 2;
  }
  if (confirmationHits >= 1) {
    return 1;
  }
  return 0;
}

function scoreNaturalness(steps) {
  const templateHits = countTemplatePhraseHits(steps);
  if (templateHits <= 1) {
    return 2;
  }
  if (templateHits <= 3) {
    return 1;
  }
  return 0;
}

function scoreRevisitReadiness(steps, finalSession) {
  const skipHandled = steps.some(
    (step) => step.controlIntent === "skip" && step.tutorAction === "advance" && step.revisitQueueSize > 0
  );
  if (skipHandled) {
    return 2;
  }
  if ((finalSession.revisitQueue || []).length > 0) {
    return 1;
  }
  return 0;
}

function buildScorecard(steps, finalSession) {
  return {
    knowledgeClosure: scoreKnowledgeClosure(steps),
    teachQuality: scoreTeachQuality(steps),
    conversationEfficiency: scoreConversationEfficiency(steps),
    confirmationQuality: scoreConfirmationQuality(steps),
    naturalness: scoreNaturalness(steps),
    revisitReadiness: scoreRevisitReadiness(steps, finalSession)
  };
}

function buildReviewFlags({ scenario, steps, finalSession }) {
  const flags = [];
  const templatePhraseHits = countTemplatePhraseHits(steps);
  const repeatedTeachLoops = countRepeatedTeachLoops(steps);
  const controlResolution = buildControlResolutionMetrics(steps);
  const finalReply = steps.at(-1)?.tutorReply || "";
  const finalTakeaway = steps.at(-1)?.tutorTakeaway || "";

  if (templatePhraseHits >= 3) {
    flags.push({
      type: "templated-tone",
      severity: "medium",
      message: "模板化表达偏多，读起来更像策略输出，不像 tutor 自然回复。"
    });
  }

  if (repeatedTeachLoops >= 1) {
    flags.push({
      type: "teach-loop",
      severity: "high",
      message: "同一知识点出现连续 teach，容易落入 teach -> ask -> teach 的低效循环。"
    });
  }

  if (
    steps.some((step) => step.controlIntent === "unknown") &&
    controlResolution.unknownHandledWithTeach === 0
  ) {
    flags.push({
      type: "unknown-not-closed",
      severity: "high",
      message: "learner 明确不会后没有尽快切到 teach，当前单元收敛速度偏慢。"
    });
  }

  if (
    steps.some((step) => step.controlIntent === "skip") &&
    controlResolution.skipIntentHandled === 0
  ) {
    flags.push({
      type: "skip-not-resolved",
      severity: "medium",
      message: "用户说“下一题”后没有顺滑 advance，节奏控制仍需加强。"
    });
  }

  if (!/关键|核心|记住|结论|一句话|总结/.test(`${finalReply} ${finalTakeaway}`)) {
    flags.push({
      type: "weak-closure",
      severity: "medium",
      message: "当前会话结尾缺少稳定 takeaway，用户拿走的结论感偏弱。"
    });
  }

  if (!finalSession.currentProbe && !finalSession.nextSteps?.length) {
    flags.push({
      type: "empty-exit",
      severity: "low",
      message: "会话结束时缺少后续引导，人工 review 时需要确认是不是过早收口。"
    });
  }

  if (scenario.expectedSignals?.length && steps.length < scenario.expectedSignals.length) {
    flags.push({
      type: "shallow-coverage",
      severity: "low",
      message: "回放轮次较少，可能还没覆盖到这个场景最关心的边界。"
    });
  }

  return flags;
}

function buildStepRecord({ index, beforeSession, answer, afterSession }) {
  const latestFeedback = afterSession.latestFeedback || {};
  return {
    step: index + 1,
    controlIntent: getControlIntent(answer),
    conceptId: latestFeedback.conceptId || afterSession.currentConceptId,
    conceptTitle: latestFeedback.conceptTitle || "",
    promptAsked: beforeSession.currentProbe,
    learnerAnswer: answer,
    tutorAction: latestFeedback.action || "",
    tutorReply: latestFeedback.explanation || "",
    tutorStrength: latestFeedback.strength || "",
    tutorTakeaway: latestFeedback.takeaway || "",
    tutorGap: latestFeedback.gap || "",
    nextPrompt: afterSession.currentProbe || "",
    revisitQueueSize: afterSession.revisitQueue?.length || 0,
    masteryPreview: (afterSession.masteryMap || []).slice(0, 3).map((item) => ({
      conceptId: item.conceptId,
      state: item.state,
      confidence: item.confidence
    }))
  };
}

function toMarkdownList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

export async function runSessionReviewScenario(scenario, { intelligence } = {}) {
  const service = createAppService({
    intelligence: intelligence || createHeuristicTutorIntelligence()
  });

  let currentSession = await service.analyzeSource({
    type: "document",
    title: scenario.source.title,
    content: scenario.source.content,
    interactionPreference: scenario.interactionPreference || "balanced"
  });

  const initialSession = currentSession;
  const steps = [];

  for (let index = 0; index < scenario.learnerTurns.length; index += 1) {
    const answer = scenario.learnerTurns[index];
    const beforeSession = currentSession;
    currentSession = await service.answer({
      sessionId: currentSession.sessionId,
      answer,
      burdenSignal: "normal",
      interactionPreference: scenario.interactionPreference || "balanced"
    });
    steps.push(
      buildStepRecord({
        index,
        beforeSession,
        answer,
        afterSession: currentSession
      })
    );
    if (!currentSession.currentProbe) {
      break;
    }
  }

  const scorecard = buildScorecard(steps, currentSession);
  const totalScore = Object.values(scorecard).reduce((sum, value) => sum + value, 0);
  const reviewFlags = buildReviewFlags({
    scenario,
    steps,
    finalSession: currentSession
  });

  return {
    scenario: {
      id: scenario.id,
      title: scenario.title,
      interactionPreference: scenario.interactionPreference || "balanced",
      reviewFocus: scenario.reviewFocus || [],
      expectedSignals: scenario.expectedSignals || []
    },
    initialSession: compactSession(initialSession),
    finalSession: compactSession(currentSession),
    steps,
    metrics: {
      totalSteps: steps.length,
      templatePhraseHits: countTemplatePhraseHits(steps),
      repeatedTeachLoops: countRepeatedTeachLoops(steps),
      controlResolution: buildControlResolutionMetrics(steps)
    },
    scorecard,
    totalScore,
    reviewFlags
  };
}

export async function runSessionReviewBatch(scenarios, { concurrency = 4, intelligence } = {}) {
  const dossiers = new Array(scenarios.length);
  let cursor = 0;

  async function worker() {
    while (cursor < scenarios.length) {
      const currentIndex = cursor;
      cursor += 1;
      dossiers[currentIndex] = await runSessionReviewScenario(scenarios[currentIndex], {
        intelligence
      });
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, scenarios.length)) }, () => worker());
  await Promise.all(workers);
  return dossiers;
}

export function renderScenarioDossierMarkdown(dossier) {
  const reviewFlags = dossier.reviewFlags.length
    ? dossier.reviewFlags.map((flag) => `${flag.severity.toUpperCase()}: ${flag.message}`)
    : ["无自动标红，建议继续人工看自然度和教学质量。"];

  const steps = dossier.steps
    .map(
      (step) => `## Step ${step.step}

- Prompt: ${step.promptAsked}
- Learner: ${step.learnerAnswer}
- Action: ${step.tutorAction}
- Reply: ${step.tutorReply}
- Takeaway: ${step.tutorTakeaway || "(none)"}
- Next prompt: ${step.nextPrompt || "(conversation paused)"}
`
    )
    .join("\n");

  return `# ${dossier.scenario.title}

## Scope

- Scenario id: ${dossier.scenario.id}
- Interaction preference: ${dossier.scenario.interactionPreference}
- Total score: ${dossier.totalScore}/12

## Review focus

${toMarkdownList(dossier.scenario.reviewFocus)}

## Expected signals

${toMarkdownList(dossier.scenario.expectedSignals)}

## Scorecard

- Knowledge closure: ${dossier.scorecard.knowledgeClosure}
- Teach quality: ${dossier.scorecard.teachQuality}
- Conversation efficiency: ${dossier.scorecard.conversationEfficiency}
- Confirmation quality: ${dossier.scorecard.confirmationQuality}
- Naturalness: ${dossier.scorecard.naturalness}
- Revisit readiness: ${dossier.scorecard.revisitReadiness}

## Automatic flags

${toMarkdownList(reviewFlags)}

## Metrics

- Total steps: ${dossier.metrics.totalSteps}
- Template phrase hits: ${dossier.metrics.templatePhraseHits}
- Repeated teach loops: ${dossier.metrics.repeatedTeachLoops}
- Control turns: ${dossier.metrics.controlResolution.totalControlTurns}
- Teach intents handled: ${dossier.metrics.controlResolution.teachIntentHandled}
- Skip intents handled: ${dossier.metrics.controlResolution.skipIntentHandled}

${steps}
`;
}

export function renderBatchIndexMarkdown(dossiers) {
  const lines = [
    "# Session Review Index",
    "",
    "This file is generated by `npm run eval:sessions`.",
    "",
    "| Scenario | Score | Flags | Notable metrics |",
    "| --- | --- | --- | --- |"
  ];

  for (const dossier of dossiers) {
    const notableMetrics = [
      `template=${dossier.metrics.templatePhraseHits}`,
      `teachLoops=${dossier.metrics.repeatedTeachLoops}`,
      `controls=${dossier.metrics.controlResolution.totalControlTurns}`
    ].join(", ");
    lines.push(
      `| ${dossier.scenario.id} | ${dossier.totalScore}/12 | ${dossier.reviewFlags.length} | ${notableMetrics} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function writeSessionReviewArtifacts(
  dossiers,
  {
    outputDir = path.resolve(__dirname, "./generated")
  } = {}
) {
  await mkdir(outputDir, { recursive: true });

  for (const dossier of dossiers) {
    await writeFile(
      path.join(outputDir, `${dossier.scenario.id}.json`),
      `${JSON.stringify(dossier, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDir, `${dossier.scenario.id}.md`),
      renderScenarioDossierMarkdown(dossier),
      "utf8"
    );
  }

  await writeFile(
    path.join(outputDir, "index.json"),
    `${JSON.stringify(
      dossiers.map((dossier) => ({
        scenarioId: dossier.scenario.id,
        title: dossier.scenario.title,
        totalScore: dossier.totalScore,
        reviewFlags: dossier.reviewFlags.length,
        metrics: dossier.metrics
      })),
      null,
      2
    )}\n`,
    "utf8"
  );

  await writeFile(path.join(outputDir, "index.md"), renderBatchIndexMarkdown(dossiers), "utf8");
}
