import { mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { buildVisibleSessionView } from "../../src/view/visible-session-view.js";

const TEMPLATE_PHRASES = [
  "你的方向不算离谱",
  "我们先收窄到一个点",
  "这一点你已经抓到主要方向了",
  "我先把这一层讲清楚",
  "好，我先不让你继续猜了",
  "别在这里卡太久"
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(input) {
  let hash = 2166136261;
  for (const char of String(input)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function sample(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
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

async function loadPersonas(personasDir) {
  const names = fs.readdirSync(personasDir).filter((name) => name.endsWith(".json")).sort();
  const personas = [];
  for (const name of names) {
    personas.push(JSON.parse(await readFile(path.join(personasDir, name), "utf8")));
  }
  return personas;
}

function personaControlOdds(persona) {
  const tendency = String(persona.control_tendency || "");
  if (/高概率/.test(tendency)) {
    return { advance: 0.42, teach: 0.2 };
  }
  if (/中等概率/.test(tendency)) {
    return { advance: 0.23, teach: 0.16 };
  }
  return { advance: 0.12, teach: 0.12 };
}

function buildHeuristicLearnerAnswer({ persona, session, rng }) {
  const currentConcept = (session.concepts || []).find((item) => item.id === session.currentConceptId) || {};
  const summary = String(currentConcept.summary || "");
  const discriminators = (currentConcept.discriminators || []).slice(0, 2);
  const checkQuestion = String(session.currentProbe || "");
  const odds = personaControlOdds(persona);
  const roll = rng();

  if (roll < odds.advance) {
    return {
      answer: "下一题",
      mode: "control",
      rationale: "persona_skip_bias"
    };
  }
  if (roll < odds.advance + odds.teach) {
    return {
      answer: "讲一下",
      mode: "control",
      rationale: "persona_teach_request"
    };
  }
  if (/不知道|不清楚|不会|为什么/.test(checkQuestion) && rng() < 0.35) {
    return {
      answer: sample(rng, ["不知道", "不太清楚", "我只记得一点关键词"]),
      mode: "answer",
      rationale: "stuck_under_followup"
    };
  }

  const answerFragments = [];
  if (discriminators.length) {
    answerFragments.push(`我理解这个点要能讲清 ${discriminators.join("、")}`);
  }
  if (summary) {
    const condensed = summary.replace(/。+/g, "，").split("，").slice(0, 2).join("，");
    answerFragments.push(condensed);
  }
  if (String(persona.knowledge_profile || "").includes("关键词")) {
    answerFragments.push("但我可能还没把对象关系讲完整");
  }
  if (String(persona.answer_style || "").includes("短")) {
    answerFragments.splice(2);
  }

  const answer = answerFragments.filter(Boolean).join("，") || "我知道一点，但讲不太完整";
  return {
    answer,
    mode: "answer",
    rationale: "heuristic_partial_answer"
  };
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

function getControlIntent(answer) {
  const normalized = String(answer || "").trim();
  if (normalized === "讲一下") {
    return "teach";
  }
  if (normalized === "下一题") {
    return "advance";
  }
  return "answer";
}

function analyzeRun({ visibleTranscript, steps, finalSession }) {
  const templatePhraseHits = visibleTranscript.reduce(
    (count, entry) =>
      count +
      TEMPLATE_PHRASES.reduce((hits, phrase) => hits + (String(entry.body || "").includes(phrase) ? 1 : 0), 0),
    0
  );
  const traceCoverage = steps.length ? steps.filter((step) => step.traceId).length / steps.length : 0;
  const teachLoops = steps.reduce((count, step, index) => {
    const previous = steps[index - 1];
    if (!previous) {
      return count;
    }
    return previous.latestFeedback?.action === "teach" &&
      step.latestFeedback?.action === "teach" &&
      previous.conceptId === step.conceptId
      ? count + 1
      : count;
  }, 0);
  const repeatedQuestions = steps.reduce((count, step, index) => {
    const previous = steps[index - 1];
    if (!previous) {
      return count;
    }
    return previous.nextPrompt && previous.nextPrompt === step.nextPrompt ? count + 1 : count;
  }, 0);
  const controlCounts = steps.reduce(
    (summary, step) => {
      const intent = getControlIntent(step.learnerAnswer);
      summary[intent] = (summary[intent] || 0) + 1;
      return summary;
    },
    {}
  );

  const suggestions = [];
  if (traceCoverage < 1) {
    suggestions.push("补齐所有评测步骤的 traceId 采集，避免评测产物与 snapshot 断链。");
  }
  if (teachLoops > 0) {
    suggestions.push("减少连续 teach 循环，优先在第二次 teach 后切换为更具体的 teach-back 或切题策略。");
  }
  if (repeatedQuestions > 1) {
    suggestions.push("压缩重复追问，避免同一 follow-up question 连续出现。");
  }
  if (templatePhraseHits >= 3) {
    suggestions.push("Tutor 回复模板化较重，建议继续压低固定话术复用率。");
  }
  if (!suggestions.length) {
    suggestions.push("当前随机对话在主链稳定性和可追踪性上表现正常，可继续扩大 persona 和轮次覆盖。");
  }

  return {
    metrics: {
      totalRounds: steps.length,
      traceCoverage,
      templatePhraseHits,
      teachLoops,
      repeatedQuestions,
      controlCounts,
      finalCurrentProbe: finalSession.currentProbe || "",
      finalConceptId: finalSession.currentConceptId || ""
    },
    summary: [
      `共完成 ${steps.length} 轮 learner 操作。`,
      `trace 覆盖率 ${Math.round(traceCoverage * 100)}%。`,
      teachLoops ? `检测到 ${teachLoops} 次连续 teach loop。` : "未检测到连续 teach loop。",
      repeatedQuestions ? `检测到 ${repeatedQuestions} 次重复 follow-up question。` : "未检测到明显重复追问。"
    ].join(" "),
    suggestions
  };
}

function collectTraceBundles(traceIds, runDir) {
  const snapshotRoot = path.resolve(process.cwd(), ".omx/logs/ai-service-snapshots");
  const bundleDir = path.join(runDir, "trace-bundles");
  const bundleMap = [];
  fs.mkdirSync(bundleDir, { recursive: true });

  for (const traceId of traceIds) {
    const sourcePath = path.join(snapshotRoot, traceId, "debug_bundle.json");
    const targetPath = path.join(bundleDir, `${traceId}.debug_bundle.json`);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      bundleMap.push({
        traceId,
        copied: true,
        relativePath: path.relative(runDir, targetPath)
      });
    } else {
      bundleMap.push({
        traceId,
        copied: false,
        relativePath: ""
      });
    }
  }

  return bundleMap;
}

export async function runAutomatedEval({
  bffBaseUrl,
  runs = 1,
  rounds = 8,
  outputDir,
  seed = Date.now(),
  personasDir = path.resolve(process.cwd(), "tests/personas"),
  interactionPreference = "balanced",
  targetBaselineId = "",
  learnerMode = "heuristic-random"
}) {
  const personas = await loadPersonas(personasDir);
  const globalRng = mulberry32(hashSeed(seed));
  const runResults = [];
  await mkdir(outputDir, { recursive: true });

  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const persona = sample(globalRng, personas);
    const runSeed = hashSeed(`${seed}:${runIndex}:${persona.id}`);
    const rng = mulberry32(runSeed);

    const login = await postJson(`${bffBaseUrl}/api/auth/login`, {
      handle: `auto_eval_${Date.now()}_${runIndex}`,
      pin: "1234"
    });
    const baselines = await fetch(`${bffBaseUrl}/api/baselines`).then((response) => response.json());
    const baselineId = targetBaselineId || baselines.baselines[0]?.id;
    let session = await postJson(`${bffBaseUrl}/api/interview/start-target`, {
      userId: login.profile.user.id,
      targetBaselineId: baselineId,
      interactionPreference
    });
    const availableDomains = session.summary?.overviewDomains || [];
    const selectedDomain = sample(rng, availableDomains);
    if (selectedDomain?.id) {
      session = await postJson(`${bffBaseUrl}/api/interview/focus-domain`, {
        sessionId: session.sessionId,
        domainId: selectedDomain.id
      });
    }

    const steps = [];
    const uiStateLog = [];
    for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
      if (!session.currentProbe) {
        break;
      }

      const learnerMove = buildHeuristicLearnerAnswer({
        persona,
        session,
        rng,
        learnerMode
      });
      const next = await postJson(`${bffBaseUrl}/api/interview/answer`, {
        sessionId: session.sessionId,
        answer: learnerMove.answer,
        burdenSignal: rng() < 0.18 ? "high" : "normal",
        interactionPreference
      });

      steps.push({
        round: roundIndex + 1,
        traceId: next.traceId || "",
        learnerMode,
        learnerAnswer: learnerMove.answer,
        learnerRationale: learnerMove.rationale,
        controlIntent: getControlIntent(learnerMove.answer),
        conceptId: session.currentConceptId,
        domainId: selectedDomain?.id || "",
        domainTitle: selectedDomain?.title || "",
        promptAsked: session.currentProbe,
        latestFeedback: next.latestFeedback || null,
        nextPrompt: next.currentProbe || "",
        visibleTurnCount: (next.turns || []).length
      });
      uiStateLog.push({
        round: roundIndex + 1,
        traceId: next.traceId || "",
        currentProbe: next.currentProbe || "",
        latestFeedback: next.latestFeedback || null,
        targetMatch: next.targetMatch || null,
        latestMemoryEvents: next.latestMemoryEvents || [],
        interactionLog: next.interactionLog || []
      });

      session = next;
    }

    const visibleView = buildVisibleSessionView(session, {
      timelineLimit: Math.max((session.turns || []).length, 24)
    });
    const visibleTranscript = visibleView.chatTimeline;
    const analysis = analyzeRun({
      visibleTranscript,
      steps,
      finalSession: session
    });

    const runId = `${String(runIndex + 1).padStart(2, "0")}-${persona.id}-${runSeed}`;
    const runDir = path.join(outputDir, runId);
    await mkdir(runDir, { recursive: true });

    const artifact = {
      runId,
      seed: runSeed,
      persona,
      interactionPreference,
      targetBaselineId: baselineId,
      selectedDomain: selectedDomain || null,
      learnerMode,
      startedAt: new Date().toISOString(),
      traceIds: steps.map((step) => step.traceId).filter(Boolean),
      traceBundles: [],
      steps,
      uiStateLog,
      finalSession: {
        sessionId: session.sessionId,
        currentConceptId: session.currentConceptId,
        currentProbe: session.currentProbe,
        targetMatch: session.targetMatch,
        revisitQueue: session.revisitQueue,
        turns: session.turns,
        interactionLog: session.interactionLog || []
      },
      visibleTranscript,
      analysis
    };
    artifact.traceBundles = collectTraceBundles(artifact.traceIds, runDir);

    await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "visible-transcript.json"), `${JSON.stringify(visibleTranscript, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "visible-transcript.md"), `${renderVisibleTranscriptMarkdown(visibleTranscript)}\n`, "utf8");
    await writeFile(path.join(runDir, "ui-state-log.json"), `${JSON.stringify(uiStateLog, null, 2)}\n`, "utf8");
    await writeFile(path.join(runDir, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
    await writeFile(
      path.join(runDir, "analysis.md"),
      [
        `# Automated Eval ${runId}`,
        "",
        `- Persona: ${persona.name} (${persona.id})`,
        `- Interaction preference: ${interactionPreference}`,
        `- Total rounds: ${analysis.metrics.totalRounds}`,
        `- Trace completeness: ${Math.round(analysis.metrics.traceCoverage * 100)}%`,
        "",
        "## Summary",
        analysis.summary,
        "",
        "## Suggestions",
        ...analysis.suggestions.map((item) => `- ${item}`)
      ].join("\n"),
      "utf8"
    );

    runResults.push({
      runId,
      persona: persona.id,
      domainId: selectedDomain?.id || "",
      traceCoverage: analysis.metrics.traceCoverage,
      totalRounds: analysis.metrics.totalRounds,
      suggestions: analysis.suggestions
    });
  }

  return {
    outputDir,
    runs: runResults
  };
}
