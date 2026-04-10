import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionReviewScenarios } from "../tests/eval/scenarios.js";
import {
  runSessionReviewBatch,
  writeSessionReviewArtifacts
} from "../tests/eval/session-dossier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  })
);

const concurrency = Number(args.concurrency || 4);
const outputDir = args.output
  ? path.resolve(process.cwd(), args.output)
  : path.resolve(__dirname, "../tests/eval/generated");

const dossiers = await runSessionReviewBatch(sessionReviewScenarios, {
  concurrency
});

await writeSessionReviewArtifacts(dossiers, {
  outputDir
});

console.log(
  JSON.stringify(
    {
      outputDir,
      scenarios: dossiers.length,
      flagged: dossiers.filter((dossier) => dossier.reviewFlags.length > 0).length,
      scores: dossiers.map((dossier) => ({
        scenarioId: dossier.scenario.id,
        totalScore: dossier.totalScore,
        flags: dossier.reviewFlags.length
      }))
    },
    null,
    2
  )
);
