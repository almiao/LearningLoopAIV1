import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import {
  createSession,
  answerSession
} from "../../../src/tutor/session-orchestrator.js";
import { createHeuristicTutorIntelligence } from "../../../src/tutor/tutor-intelligence.js";
import {
  aqsMarkdownDocument,
  javaCollectionsDocument
} from "../../fixtures/materials.js";

const intelligence = createHeuristicTutorIntelligence();

test("session starts with decomposition before probing", async () => {
  const source = parseDocumentInput({
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  const session = await createSession({ source, intelligence });

  assert.ok(session.concepts.length >= 3);
  assert.ok(session.currentProbe.length > 0);
  assert.ok(session.turns.length >= 1);
  assert.equal(session.memoryMode, "session-scoped");
});

test("session answer updates mastery map and next steps", async () => {
  const source = parseDocumentInput({
    title: "Java Collections",
    content: javaCollectionsDocument
  });

  const session = await createSession({ source, intelligence });
  const firstPass = await answerSession(session, {
    answer:
      "HashMap depends on stable hashCode and equals, while ConcurrentHashMap reduces contention in concurrent workloads.",
    burdenSignal: "normal",
    intelligence
  });

  assert.ok(firstPass.masteryMap.length >= 3);
  assert.ok(firstPass.nextSteps.length >= 3);
  assert.ok(firstPass.latestFeedback.judge.state !== "solid");
  assert.ok(firstPass.turns.length >= 3);
  assert.ok(["affirm", "deepen", "advance"].includes(firstPass.latestFeedback.action));
  assert.match(firstPass.latestFeedback.explanation, /抓住|关键点|往前一步/);

  const secondPass = await answerSession(firstPass, {
    answer:
      "A backend interviewer may ask for tradeoffs: HashMap is fast for lookup, ConcurrentHashMap improves concurrent writes, and CopyOnWriteArrayList favors read-heavy traffic.",
    burdenSignal: "normal",
    intelligence
  });

  assert.ok(
    secondPass.masteryMap.some((item) => item.state === "solid" || item.state === "partial")
  );
});

test("aqs session starts with a concrete document-local question and narrows after a weak answer", async () => {
  const source = parseDocumentInput({
    title: "AQS 详解",
    content: aqsMarkdownDocument
  });

  const session = await createSession({ source, intelligence });

  assert.match(session.currentProbe, /AQS|CLH|state|模板方法/);
  assert.doesNotMatch(session.currentProbe, /为什么重要|容易答错/);

  const afterWeakAnswer = await answerSession(session, {
    answer: "就是并发里很重要的一个东西。",
    burdenSignal: "normal",
    intelligence
  });

  assert.ok(afterWeakAnswer.latestFeedback.explanation.length > 0);
  assert.ok(["repair", "teach"].includes(afterWeakAnswer.latestFeedback.action));
  assert.ok(afterWeakAnswer.latestFeedback.gap.length > 0);
  assert.ok(afterWeakAnswer.latestFeedback.evidenceReference.length > 0);
  assert.ok(afterWeakAnswer.latestFeedback.coachingStep.length > 0);
  assert.match(afterWeakAnswer.currentProbe, /AQS|CLH|state|模板方法|复述|底座/);
  assert.doesNotMatch(afterWeakAnswer.currentProbe, /换个角度再解释一次|为什么重要/);
});

test("explain-first preference switches weak answers into teach then check", async () => {
  const source = parseDocumentInput({
    title: "AQS 详解",
    content: aqsMarkdownDocument
  });

  const session = await createSession({
    source,
    intelligence,
    interactionPreference: "explain-first"
  });

  const updated = await answerSession(session, {
    answer: "不太清楚，感觉就是个锁。",
    burdenSignal: "normal",
    interactionPreference: "explain-first",
    intelligence
  });

  assert.equal(updated.latestFeedback.action, "teach");
  assert.match(updated.latestFeedback.explanation, /先把这一层讲清楚|先不继续硬追问|先补一小段关键解释/);
  assert.ok(updated.latestFeedback.teachingChunk.length > 0);
  assert.match(updated.currentProbe, /复述|自己的话/);
});

test("control intents can advance or teach without being treated as learner content", async () => {
  const source = parseDocumentInput({
    title: "AQS 详解",
    content: aqsMarkdownDocument
  });

  const session = await createSession({
    source,
    intelligence,
    interactionPreference: "balanced"
  });
  const initialConceptId = session.currentConceptId;

  const taught = await answerSession(session, {
    answer: "讲一下",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });

  assert.equal(taught.latestFeedback.action, "teach");
  assert.match(taught.latestFeedback.explanation, /先不让你继续猜|先带走这一层|先补一小段关键解释/);
  assert.equal(taught.engagement.controlCount, 1);
  assert.equal(taught.engagement.teachRequestCount, 1);
  assert.equal(taught.currentConceptId, initialConceptId);

  const advanced = await answerSession(taught, {
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });

  assert.equal(advanced.latestFeedback.action, "advance");
  assert.notEqual(advanced.currentConceptId, initialConceptId);
  assert.equal(advanced.engagement.controlCount, 2);
  assert.equal(advanced.engagement.skipCount, 1);
  assert.ok(advanced.revisitQueue.length >= 1);
});

test("repeated teach requests stay on the same concept and continue teach-back", async () => {
  const source = parseDocumentInput({
    title: "AQS 详解",
    content: aqsMarkdownDocument
  });

  let session = await createSession({
    source,
    intelligence,
    interactionPreference: "balanced"
  });

  session = await answerSession(session, {
    answer: "讲一下",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });
  const conceptBeforeSecondTeach = session.currentConceptId;

  const afterSecondTeach = await answerSession(session, {
    answer: "讲一下",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });

  assert.match(afterSecondTeach.latestFeedback.explanation, /我换个角度再讲一次|先带走这一层/);
  assert.equal(afterSecondTeach.currentConceptId, conceptBeforeSecondTeach);
  assert.match(afterSecondTeach.currentProbe, /复述|自己的话|为什么/);
});

test("deferred units can be revisited after the primary pass completes", async () => {
  const source = parseDocumentInput({
    title: "Mini Source",
    content: `${javaCollectionsDocument}\n\n${javaCollectionsDocument}`
  });

  const customIntelligence = {
    async decomposeSource() {
      return {
        summary: {
          sourceTitle: "Mini Source",
          keyThemes: ["A", "B", "C"],
          framing: "mini"
        },
        concepts: [
          {
            id: "a",
            title: "A",
            summary: "A summary",
            excerpt: "A excerpt",
            diagnosticQuestion: "Question A?",
            retryQuestion: "Retry A?",
            stretchQuestion: "Stretch A?",
            checkQuestion: "Check A?",
            keywords: [],
            sourceAnchors: ["A excerpt"],
            misconception: "",
            importance: "core",
            coverage: "medium"
          },
          {
            id: "b",
            title: "B",
            summary: "B summary",
            excerpt: "B excerpt",
            diagnosticQuestion: "Question B?",
            retryQuestion: "Retry B?",
            stretchQuestion: "Stretch B?",
            checkQuestion: "Check B?",
            keywords: [],
            sourceAnchors: ["B excerpt"],
            misconception: "",
            importance: "secondary",
            coverage: "medium"
          },
          {
            id: "c",
            title: "C",
            summary: "C summary",
            excerpt: "C excerpt",
            diagnosticQuestion: "Question C?",
            retryQuestion: "Retry C?",
            stretchQuestion: "Stretch C?",
            checkQuestion: "Check C?",
            keywords: [],
            sourceAnchors: ["C excerpt"],
            misconception: "",
            importance: "secondary",
            coverage: "medium"
          }
        ]
      };
    },
    async generateTutorMove({ concept }) {
      return {
        moveType: "advance",
        signal: "positive",
        judge: {
          state: "partial",
          confidence: 0.6,
          reasons: ["ok"]
        },
        visibleReply: `done ${concept.title}`,
        evidenceReference: concept.excerpt,
        teachingChunk: "",
        nextQuestion: "",
        takeaway: concept.summary,
        confirmedUnderstanding: "",
        remainingGap: "",
        revisitReason: "",
        completeCurrentUnit: true,
        requiresResponse: false
      };
    }
  };

  let session = await createSession({ source, intelligence: customIntelligence });
  session = await answerSession(session, {
    answer: "下一题",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence: customIntelligence
  });
  session = await answerSession(session, {
    answer: "ok",
    burdenSignal: "normal",
    intelligence: customIntelligence
  });
  session = await answerSession(session, {
    answer: "ok",
    burdenSignal: "normal",
    intelligence: customIntelligence
  });

  assert.match(session.currentProbe, /回到刚才先放下的这个点/);
});

test("candidate follow-up is hidden when orchestration switches to a new concept", async () => {
  const source = parseDocumentInput({
    title: "Mini Source",
    content: `${javaCollectionsDocument}\n\n${javaCollectionsDocument}`
  });

  const customIntelligence = {
    async decomposeSource() {
      return {
        summary: {
          sourceTitle: "Mini Source",
          keyThemes: ["A", "B", "C"],
          framing: "mini"
        },
        concepts: [
          {
            id: "a",
            title: "A",
            summary: "A summary",
            excerpt: "A excerpt",
            diagnosticQuestion: "Question A?",
            retryQuestion: "Retry A?",
            stretchQuestion: "Stretch A?",
            checkQuestion: "Check A?",
            keywords: [],
            sourceAnchors: ["A excerpt"],
            misconception: "",
            importance: "core",
            coverage: "medium"
          },
          {
            id: "b",
            title: "B",
            summary: "B summary",
            excerpt: "B excerpt",
            diagnosticQuestion: "Question B?",
            retryQuestion: "Retry B?",
            stretchQuestion: "Stretch B?",
            checkQuestion: "Check B?",
            keywords: [],
            sourceAnchors: ["B excerpt"],
            misconception: "",
            importance: "secondary",
            coverage: "medium"
          },
          {
            id: "c",
            title: "C",
            summary: "C summary",
            excerpt: "C excerpt",
            diagnosticQuestion: "Question C?",
            retryQuestion: "Retry C?",
            stretchQuestion: "Stretch C?",
            checkQuestion: "Check C?",
            keywords: [],
            sourceAnchors: ["C excerpt"],
            misconception: "",
            importance: "secondary",
            coverage: "medium"
          }
        ]
      };
    },
    async generateTutorMove() {
      return {
        moveType: "deepen",
        signal: "positive",
        judge: {
          state: "solid",
          confidence: 0.85,
          reasons: ["enough"]
        },
        visibleReply: "这个点的主干你已经说到了。",
        evidenceReference: "A excerpt",
        teachingChunk: "",
        nextQuestion: "如果继续留在这一题，我会追问这个细节？",
        takeaway: "A summary",
        confirmedUnderstanding: "你已经抓到 A 的主干。",
        remainingGap: "",
        revisitReason: "",
        completeCurrentUnit: false,
        requiresResponse: true
      };
    }
  };

  const session = await createSession({ source, intelligence: customIntelligence });
  const updated = await answerSession(session, {
    answer: "Answer A",
    burdenSignal: "normal",
    intelligence: customIntelligence
  });

  assert.equal(updated.currentConceptId, "b");
  assert.equal(updated.currentProbe, "Question B?");
  assert.equal(updated.latestFeedback.action, "deepen");
  assert.equal(updated.latestFeedback.candidateCoachingStep, "如果继续留在这一题，我会追问这个细节？");
  assert.equal(updated.latestFeedback.coachingStep, "");
  assert.equal(updated.latestFeedback.turnResolution.mode, "switch");
  assert.equal(updated.latestFeedback.nextMove, null);
});
