import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProviderJsonText } from "../src/tutor/tutor-intelligence.js";
import { createAppService } from "../src/app-service.js";
import { createHeuristicTutorIntelligence } from "../src/tutor/tutor-intelligence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  })
);

const personaPath = args.persona
  ? path.resolve(process.cwd(), args.persona)
  : path.resolve(__dirname, "../tests/personas/cautious-junior.json");
const sourcePath = args.source
  ? path.resolve(process.cwd(), args.source)
  : path.resolve(__dirname, "../tests/fixtures/materials.js");
const maxTurns = Number(args.turns || 8);
const outputDir = path.resolve(__dirname, "../.omx/simulations");

function getLearnerProviderConfig() {
  const provider = String(process.env.LLAI_SIM_LLM_PROVIDER || process.env.LLAI_LLM_PROVIDER || "DEEPSEEK").toUpperCase();
  if (provider !== "DEEPSEEK") {
    throw new Error(`Unsupported simulated learner provider: ${provider}`);
  }

  return {
    provider,
    apiKey: process.env.LLAI_SIM_DEEPSEEK_API_KEY || process.env.LLAI_DEEPSEEK_API_KEY,
    baseUrl: process.env.LLAI_SIM_DEEPSEEK_BASE_URL || process.env.LLAI_DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.LLAI_SIM_DEEPSEEK_MODEL || process.env.LLAI_DEEPSEEK_MODEL || "deepseek-chat",
    timeoutMs: Number(process.env.LLAI_SIM_TIMEOUT_MS || 60000)
  };
}

async function callDeepSeekJson({ apiKey, baseUrl, model, prompt, timeoutMs }) {
  if (!apiKey) {
    throw new Error("Simulated learner API key is missing. Set LLAI_SIM_DEEPSEEK_API_KEY or LLAI_DEEPSEEK_API_KEY.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        response_format: {
          type: "json_object"
        },
        messages: [
          {
            role: "system",
            content:
              "You are simulating a learner in a tutoring session. Return valid json only. " +
              "Do not behave like a tutor. Reply like a human learner with concise natural answers."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Simulated learner request failed: ${response.status} ${errorText}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    return parseProviderJsonText(content);
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt({ persona, session, currentQuestion }) {
  const transcript = (session.turns || [])
    .slice(-8)
    .map((turn) => `${turn.role === "tutor" ? "Tutor" : "Learner"}: ${turn.content}`)
    .join("\n");

  return [
    "Simulate the next learner reply in this tutoring session.",
    "Reply in Chinese unless a short English technical term is natural.",
    "Be concise and human-like.",
    "If the persona would skip, ask for explanation, or summarize, answer exactly with one of: 下一题 / 讲一下 / 总结一下",
    "",
    `Persona name: ${persona.name}`,
    `Persona description: ${persona.description}`,
    `Answer style: ${persona.answer_style}`,
    `Control tendency: ${persona.control_tendency}`,
    `Knowledge profile: ${persona.knowledge_profile}`,
    "",
    `Current topic: ${session.concepts.find((item) => item.id === session.currentConceptId)?.title || ""}`,
    `Current question: ${currentQuestion}`,
    "",
    "Recent transcript:",
    transcript,
    "",
    'Return JSON like {"answer":"...","why":"brief reason for simulation choice"}'
  ].join("\n");
}

async function loadPersona() {
  const raw = await readFile(personaPath, "utf8");
  return JSON.parse(raw);
}

async function loadSourceDocument() {
  if (sourcePath.endsWith(".md") || sourcePath.endsWith(".txt")) {
    return {
      title: path.basename(sourcePath, path.extname(sourcePath)),
      content: await readFile(sourcePath, "utf8")
    };
  }

  throw new Error("Please pass --source=<path-to-md-or-txt> for simulation.");
}

function createLocalRunner() {
  const service = createAppService({
    intelligence: createHeuristicTutorIntelligence()
  });

  return {
    async analyze(payload) {
      return service.analyzeSource(payload);
    },
    async answer(payload) {
      return service.answer(payload);
    }
  };
}

const persona = await loadPersona();
const source = await loadSourceDocument();
const providerConfig = getLearnerProviderConfig();
const runner = createLocalRunner();

const session = await runner.analyze({
  type: "document",
  title: source.title,
  content: source.content,
  interactionPreference: "balanced"
});

let current = session;
const transcript = [...(session.turns || [])];

for (let index = 0; index < maxTurns; index += 1) {
  if (!current.currentProbe) {
    break;
  }

  const learnerMove = await callDeepSeekJson({
    ...providerConfig,
    prompt: buildPrompt({
      persona,
      session: current,
      currentQuestion: current.currentProbe
    })
  });

  current = await runner.answer({
    sessionId: current.sessionId,
    answer: learnerMove.answer,
    burdenSignal: "normal",
    interactionPreference: "balanced"
  });

  transcript.push(...(current.turns || []).slice(transcript.length));
}

await mkdir(outputDir, { recursive: true });
const outputPath = path.join(
  outputDir,
  `${persona.id}-${Date.now()}.json`
);

await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      persona,
      serverUrl: "local-heuristic",
      sourceTitle: source.title,
      transcript,
      finalState: {
        currentConceptId: current.currentConceptId,
        currentProbe: current.currentProbe,
        masteryMap: current.masteryMap,
        nextSteps: current.nextSteps,
        revisitQueue: current.revisitQueue
      }
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(
  JSON.stringify(
    {
      outputPath,
      persona: persona.id,
      turns: transcript.length,
      currentProbe: current.currentProbe,
      revisitQueue: current.revisitQueue?.length || 0
    },
    null,
    2
  )
);
