import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildVisibleSessionView } from "../src/view/visible-session-view.js";

const DEFAULT_DOMAINS = ["service-reliability", "database-core"];

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

function buildPartialAnswer(session, round) {
  const concept = (session.concepts || []).find((item) => item.id === session.currentConceptId) || {};
  const keywords = (concept.keywords || []).slice(0, 3).join("、");
  const summary = String(concept.summary || "").replace(/。+/g, "，").split("，").slice(0, 1).join("，");

  if (round === 5) {
    return `我试着串一下：${summary || concept.title}，但边界和例子可能还不完整。`;
  }
  if (round === 3) {
    return `我知道这个点跟 ${keywords || concept.title} 有关，不过还没形成完整链路。`;
  }
  return `我理解这个点主要跟 ${keywords || concept.title} 有关，${summary || concept.summary || "但我可能还没讲完整"}，但我可能还没把对象关系讲完整。`;
}

function plannedMove(session, round) {
  if (round === 2) {
    return { answer: "讲一下", intent: "teach", rationale: "structured_teach_button" };
  }
  if (round === 4) {
    return { answer: "下一题", intent: "advance", rationale: "structured_advance_button" };
  }
  return { answer: buildPartialAnswer(session, round), intent: "", rationale: "domain_partial_answer" };
}

async function runDomain({ baseUrl, baselineId, domain, outputRoot, index }) {
  const login = await postJson(`${baseUrl}/api/auth/login`, {
    handle: `two_domain_eval_${Date.now()}_${index}`,
    pin: "1234"
  });

  let session = await postJson(`${baseUrl}/api/interview/start-target`, {
    userId: login.profile.user.id,
    targetBaselineId: baselineId,
    interactionPreference: "balanced"
  });

  session = await postJson(`${baseUrl}/api/interview/focus-domain`, {
    sessionId: session.sessionId,
    domainId: domain.id
  });

  const steps = [];
  for (let round = 1; round <= 5; round += 1) {
    if (!session.currentProbe) {
      break;
    }

    const move = plannedMove(session, round);
    const before = session;
    session = await postJson(`${baseUrl}/api/interview/answer`, {
      sessionId: session.sessionId,
      answer: move.answer,
      intent: move.intent,
      burdenSignal: round === 5 ? "high" : "normal",
      interactionPreference: "balanced"
    });

    steps.push({
      round,
      traceId: session.traceId || "",
      domainId: domain.id,
      domainTitle: domain.title,
      conceptId: before.currentConceptId,
      promptAsked: before.currentProbe,
      learnerAnswer: move.answer,
      learnerIntent: move.intent || "answer",
      learnerRationale: move.rationale,
      tutorAction: session.latestFeedback?.action || "",
      tutorState: session.latestFeedback?.judge?.state || "",
      currentProbeAfter: session.currentProbe || ""
    });
  }

  const visibleView = buildVisibleSessionView(session, {
    timelineLimit: Math.max((session.turns || []).length, 24)
  });
  const visibleTranscript = visibleView.chatTimeline;
  const runId = `${String(index + 1).padStart(2, "0")}-${domain.id}`;
  const runDir = path.join(outputRoot, runId);

  await mkdir(runDir, { recursive: true });
  const artifact = {
    runId,
    domain,
    steps,
    finalSession: {
      sessionId: session.sessionId,
      currentConceptId: session.currentConceptId,
      currentProbe: session.currentProbe,
      turns: session.turns,
      latestFeedback: session.latestFeedback,
      interactionLog: session.interactionLog || []
    },
    visibleTranscript
  };

  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "visible-transcript.json"), `${JSON.stringify(visibleTranscript, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "visible-transcript.md"), `${renderVisibleTranscriptMarkdown(visibleTranscript)}\n`, "utf8");

  return {
    runId,
    runDir,
    rounds: steps.length,
    domainTitle: domain.title,
    traceIds: steps.map((step) => step.traceId).filter(Boolean)
  };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, "").split("=");
      return [key, rest.join("=") || "true"];
    })
  );

  const baseUrl = args.url || "http://127.0.0.1:4000";
  const outputRoot = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.resolve(process.cwd(), ".omx/automated-evals/two-domain-visible-5-rounds");
  const preferredDomains = (args.domains ? args.domains.split(",") : DEFAULT_DOMAINS).filter(Boolean);

  await mkdir(outputRoot, { recursive: true });

  const probeLogin = await postJson(`${baseUrl}/api/auth/login`, {
    handle: `domain_probe_${Date.now()}`,
    pin: "1234"
  });
  const baselines = await fetch(`${baseUrl}/api/baselines`).then((response) => response.json());
  const baselineId = baselines.baselines[0].id;

  const probeSession = await postJson(`${baseUrl}/api/interview/start-target`, {
    userId: probeLogin.profile.user.id,
    targetBaselineId: baselineId,
    interactionPreference: "balanced"
  });

  const availableDomains = probeSession.summary?.overviewDomains || [];
  const selected = preferredDomains
    .map((id) => availableDomains.find((domain) => domain.id === id))
    .filter(Boolean)
    .slice(0, 2);

  for (const domain of availableDomains) {
    if (selected.length >= 2) {
      break;
    }
    if (!selected.some((item) => item.id === domain.id)) {
      selected.push(domain);
    }
  }

  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    results.push(await runDomain({ baseUrl, baselineId, domain: selected[index], outputRoot, index }));
  }

  await writeFile(path.join(outputRoot, "index.json"), `${JSON.stringify({ outputRoot, results }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputRoot, results }, null, 2));
}

await main();
