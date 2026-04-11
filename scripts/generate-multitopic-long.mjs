import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildVisibleSessionView } from "../src/view/visible-session-view.js";

const DEFAULT_DOMAINS = ["service-reliability", "database-core", "java-concurrency", "messaging-async"];

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { error: rawText || "Request failed" };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJsonWithRetry(url, payload, { retries = 2, delayMs = 1500 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postJson(url, payload);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(delayMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

function renderVisibleTranscriptMarkdown(entries) {
  return entries
    .map((entry) => {
      if (entry.type === "event") {
        return `## ${entry.label}`;
      }

      const bodyParts = (entry.bodyParts?.length ? entry.bodyParts : [entry.body]).filter(Boolean);
      const lines = [
        `### ${entry.role === "assistant" ? "Tutor" : "你"}${entry.conceptTitle ? ` · ${entry.conceptTitle}` : ""}`,
        ...bodyParts
      ];

      if (entry.topicShiftLabel) {
        lines.push(entry.topicShiftLabel);
      }
      if (entry.takeaway) {
        lines.push(`带走一句：${entry.takeaway}`);
      }
      if (entry.followUpQuestion) {
        lines.push(`接下来 Tutor 会继续问：${entry.followUpQuestion}`);
      } else if (entry.candidateFollowUpQuestion) {
        lines.push(`如果继续留在这一题，Tutor 会追问：${entry.candidateFollowUpQuestion}`);
      }
      if (entry.coachingStep) {
        lines.push(`下一步：${entry.coachingStep}`);
      }
      if (entry.intentLabel) {
        lines.push(`用户动作：${entry.intentLabel}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildPartialAnswer(session, roundInDomain, globalRound) {
  const concept = (session.concepts || []).find((item) => item.id === session.currentConceptId) || {};
  const keywords = (concept.keywords || []).slice(0, 3).join("、");
  const summary = String(concept.summary || "").replace(/。+/g, "，").split("，").slice(0, 1).join("，");

  if (roundInDomain === 5) {
    return `我试着串一下：${summary || concept.title}，但边界和例子可能还不完整。`;
  }
  if (globalRound % 3 === 0) {
    return `我知道这个点跟 ${keywords || concept.title} 有关，不过还没形成完整链路。`;
  }
  return `我理解这个点主要跟 ${keywords || concept.title} 有关，${summary || concept.summary || "但我可能还没讲完整"}，但我可能还没把对象关系讲完整。`;
}

function plannedMove(session, roundInDomain, globalRound) {
  if (roundInDomain === 2) {
    return { answer: "讲一下", intent: "teach", rationale: "structured_teach_button" };
  }
  if (roundInDomain === 4) {
    return { answer: "下一题", intent: "advance", rationale: "structured_advance_button" };
  }
  return { answer: buildPartialAnswer(session, roundInDomain, globalRound), intent: "", rationale: "domain_partial_answer" };
}

async function run() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"];
    })
  );

  const baseUrl = args.url || "http://127.0.0.1:4000";
  const outputDir = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.resolve(process.cwd(), ".omx/automated-evals/multi-topic-20-rounds");
  const preferredDomains = (args.domains ? args.domains.split(",") : DEFAULT_DOMAINS).filter(Boolean);
  const roundsPerDomain = Number(args.rounds_per_domain || 5);

  await mkdir(outputDir, { recursive: true });

  const login = await postJsonWithRetry(`${baseUrl}/api/auth/login`, {
    handle: `multitopic_${Date.now()}`,
    pin: "1234"
  });
  const baselines = await fetch(`${baseUrl}/api/baselines`).then((response) => response.json());

  let session = await postJsonWithRetry(`${baseUrl}/api/interview/start-target`, {
    userId: login.profile.user.id,
    targetBaselineId: baselines.baselines[0].id,
    interactionPreference: "balanced"
  });

  const availableDomains = session.summary?.overviewDomains || [];
  const selectedDomains = preferredDomains
    .map((id) => availableDomains.find((domain) => domain.id === id))
    .filter(Boolean);

  const rounds = [];
  let globalRound = 0;

  for (const domain of selectedDomains) {
    session = await postJsonWithRetry(`${baseUrl}/api/interview/focus-domain`, {
      sessionId: session.sessionId,
      domainId: domain.id
    });

    for (let roundInDomain = 1; roundInDomain <= roundsPerDomain; roundInDomain += 1) {
      if (!session.currentProbe) {
        break;
      }

      globalRound += 1;
      const move = plannedMove(session, roundInDomain, globalRound);
      const before = session;

      try {
        session = await postJsonWithRetry(
          `${baseUrl}/api/interview/answer`,
          {
            sessionId: session.sessionId,
            answer: move.answer,
            intent: move.intent,
            burdenSignal: globalRound >= selectedDomains.length * roundsPerDomain - 2 ? "high" : "normal",
            interactionPreference: "balanced"
          },
          { retries: 3, delayMs: 2000 }
        );
      } catch (error) {
        rounds.push({
          globalRound,
          roundInDomain,
          domainId: domain.id,
          domainTitle: domain.title,
          conceptId: before.currentConceptId,
          promptAsked: before.currentProbe,
          learnerAnswer: move.answer,
          learnerIntent: move.intent || "answer",
          learnerRationale: move.rationale,
          tutorAction: "request_failed",
          tutorState: "",
          traceId: "",
          currentProbeAfter: before.currentProbe || "",
          error: error instanceof Error ? error.message : String(error)
        });
        const partialView = buildVisibleSessionView(before, {
          timelineLimit: Math.max((before.turns || []).length, 120)
        });
        const partialArtifact = {
          sessionId: before.sessionId || before.id || "",
          selectedDomains: selectedDomains.map((item) => ({ id: item.id, title: item.title })),
          totalRounds: rounds.length,
          rounds,
          failedAt: { globalRound, roundInDomain, domainId: domain.id },
          visibleTranscript: partialView.chatTimeline
        };
        await writeFile(path.join(outputDir, "partial-run.json"), `${JSON.stringify(partialArtifact, null, 2)}\n`, "utf8");
        throw error;
      }

      rounds.push({
        globalRound,
        roundInDomain,
        domainId: domain.id,
        domainTitle: domain.title,
        conceptId: before.currentConceptId,
        promptAsked: before.currentProbe,
        learnerAnswer: move.answer,
        learnerIntent: move.intent || "answer",
        learnerRationale: move.rationale,
        tutorAction: session.latestFeedback?.action || "",
        tutorState: session.latestFeedback?.judge?.state || "",
        traceId: session.traceId || "",
        currentProbeAfter: session.currentProbe || ""
      });
    }
  }

  const visibleView = buildVisibleSessionView(session, {
    timelineLimit: Math.max((session.turns || []).length, 120)
  });

  const artifact = {
    sessionId: session.sessionId,
    selectedDomains: selectedDomains.map((domain) => ({ id: domain.id, title: domain.title })),
    totalRounds: rounds.length,
    rounds,
    finalSession: {
      currentConceptId: session.currentConceptId,
      currentProbe: session.currentProbe,
      latestFeedback: session.latestFeedback,
      turns: session.turns,
      interactionLog: session.interactionLog || []
    },
    visibleTranscript: visibleView.chatTimeline
  };

  await writeFile(path.join(outputDir, "run.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "visible-transcript.json"), `${JSON.stringify(visibleView.chatTimeline, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "visible-transcript.md"), `${renderVisibleTranscriptMarkdown(visibleView.chatTimeline)}\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        outputDir,
        totalRounds: rounds.length,
        domains: selectedDomains.map((domain) => domain.id)
      },
      null,
      2
    )
  );
}

await run();
