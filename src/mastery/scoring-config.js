import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scoringConfigPath = path.resolve(__dirname, "../../contracts/mastery-scoring-v1.json");

export const masteryScoringConfig = JSON.parse(readFileSync(scoringConfigPath, "utf8"));
