import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const casesDir = path.resolve(__dirname, "../tests/cases");

const requiredKeys = [
  "id",
  "topic",
  "source",
  "user_goal",
  "transcript",
  "observed_problems",
  "desired_behavior",
  "success_signals"
];

function validateCaseShape(data) {
  for (const key of requiredKeys) {
    if (!(key in data)) {
      throw new Error(`missing key: ${key}`);
    }
  }

  if (!Array.isArray(data.transcript) || data.transcript.length < 2) {
    throw new Error("transcript must have at least 2 turns");
  }

  if (!Array.isArray(data.observed_problems) || data.observed_problems.length === 0) {
    throw new Error("observed_problems must be non-empty");
  }

  if (!Array.isArray(data.desired_behavior) || data.desired_behavior.length === 0) {
    throw new Error("desired_behavior must be non-empty");
  }

  if (!Array.isArray(data.success_signals) || data.success_signals.length === 0) {
    throw new Error("success_signals must be non-empty");
  }
}

const files = (await readdir(casesDir))
  .filter((file) => file.endsWith("-user-case.json"))
  .sort();

const results = [];
const topicStats = {};

for (const file of files) {
  const raw = await readFile(path.join(casesDir, file), "utf8");
  const data = JSON.parse(raw);
  validateCaseShape(data);
  topicStats[data.topic] = {
    transcriptTurns: data.transcript.length,
    observedProblems: data.observed_problems.length,
    desiredBehavior: data.desired_behavior.length,
    successSignals: data.success_signals.length
  };
  results.push({
    file,
    id: data.id,
    topic: data.topic,
    transcriptTurns: data.transcript.length,
    observedProblems: data.observed_problems.length
  });
}

console.log(
  JSON.stringify(
    {
      caseCount: results.length,
      cases: results,
      topics: topicStats
    },
    null,
    2
  )
);
