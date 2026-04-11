import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAutomatedEval } from "../tests/eval/automated-eval.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  })
);

const runs = Number(args.runs || 1);
const rounds = Number(args.rounds || 8);
const seed = args.seed || Date.now();
const bffBaseUrl = args.url || "http://127.0.0.1:4000";
const outputDir = args.output
  ? path.resolve(process.cwd(), args.output)
  : path.resolve(__dirname, "../.omx/automated-evals", String(Date.now()));
const personasDir = args.personas
  ? path.resolve(process.cwd(), args.personas)
  : path.resolve(__dirname, "../tests/personas");
const interactionPreference = args.preference || "balanced";
const targetBaselineId = args.baseline || "";
const learnerMode = args.mode || "heuristic-random";

const result = await runAutomatedEval({
  bffBaseUrl,
  runs,
  rounds,
  outputDir,
  seed,
  personasDir,
  interactionPreference,
  targetBaselineId,
  learnerMode
});

console.log(JSON.stringify(result, null, 2));
