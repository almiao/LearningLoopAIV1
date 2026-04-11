import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppService } from "../src/app-service.js";
import { createHeuristicTutorIntelligence } from "../src/tutor/tutor-intelligence.js";
import { aqsMarkdownDocument } from "../tests/fixtures/materials.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const legacyBaseline = JSON.parse(
  readFileSync(path.resolve(__dirname, "../tests/cases/aqs-legacy-baseline.json"), "utf8")
);

const genericThemePattern = /Concurrency|Collections|HTTP|Java Fundamentals|JVM/;
const genericQuestionPattern = /为什么重要|容易答错|换个角度再解释/;
const metadataNoisePattern = /^---|^title:|^description:|^tag:|^category:/im;

function scoreLegacyCase(legacy) {
  return {
    documentLocalUnits: legacy.themes.every((item) => !genericThemePattern.test(item)) ? 1 : 0,
    concreteFirstQuestion: genericQuestionPattern.test(legacy.firstQuestion) ? 0 : 1,
    cleanDecomposition: legacy.decompositionPreview.some((item) => metadataNoisePattern.test(item)) ? 0 : 1,
    correctiveFeedback: legacy.feedbackStyle === "generic" ? 0 : 1,
    multiTurnHistory: 0
  };
}

function scoreCurrentCase(session, updated) {
  return {
    documentLocalUnits: session.concepts.every((item) => !genericThemePattern.test(item.title)) ? 1 : 0,
    concreteFirstQuestion: genericQuestionPattern.test(session.currentProbe) ? 0 : 1,
    cleanDecomposition: session.concepts.every((item) => !metadataNoisePattern.test(item.summary)) ? 1 : 0,
    correctiveFeedback:
      updated.latestFeedback?.gap && updated.latestFeedback?.evidenceReference && updated.latestFeedback?.coachingStep
        ? 1
        : 0,
    multiTurnHistory: Array.isArray(updated.turns) && updated.turns.length >= 3 ? 1 : 0
  };
}

function totalScore(scorecard) {
  return Object.values(scorecard).reduce((sum, value) => sum + value, 0);
}

const service = createAppService({
  intelligence: createHeuristicTutorIntelligence()
});

const session = await service.analyzeSource({
  type: "document",
  title: "AQS 详解",
  content: aqsMarkdownDocument,
  interactionPreference: "balanced"
});

const updated = await service.answer({
  sessionId: session.sessionId,
  answer: "就是并发里一个很重要的类。",
  burdenSignal: "normal",
  interactionPreference: "balanced"
});

const legacyScore = scoreLegacyCase(legacyBaseline);
const currentScore = scoreCurrentCase(session, updated);

console.log(
  JSON.stringify(
    {
      legacy: {
        scorecard: legacyScore,
        total: totalScore(legacyScore)
      },
      current: {
        scorecard: currentScore,
        total: totalScore(currentScore)
      },
      improved: totalScore(currentScore) > totalScore(legacyScore),
      currentPreview: {
        titles: session.concepts.slice(0, 3).map((item) => item.title),
        firstQuestion: session.currentProbe,
        feedback: updated.latestFeedback?.explanation
      }
    },
    null,
    2
  )
);
