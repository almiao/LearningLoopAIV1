import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const casesDir = path.resolve(__dirname, "../../.omx/cases");

function buildCaseSnapshot(session) {
  return {
    sessionId: session.id,
    recordedAt: new Date().toISOString(),
    source: {
      title: session.source.title,
      kind: session.source.kind,
      url: session.source.url
    },
    interactionPreference: session.interactionPreference,
    burdenSignal: session.burdenSignal,
    summary: session.summary,
    targetBaseline: session.targetBaseline,
    memoryProfileId: session.memoryProfileId,
    concepts: session.concepts,
    currentConceptId: session.currentConceptId,
    currentProbe: session.currentProbe,
    masteryMap: session.masteryMap,
    abilityDomains: session.abilityDomains,
    targetMatch: session.targetMatch,
    nextSteps: session.nextSteps,
    engagement: session.engagement,
    revisitQueue: session.revisitQueue,
    memoryEvents: session.memoryEvents,
    turns: session.turns ?? []
  };
}

export async function recordSessionCase(session) {
  await mkdir(casesDir, { recursive: true });
  const filePath = path.join(casesDir, `${session.id}.json`);
  await writeFile(filePath, `${JSON.stringify(buildCaseSnapshot(session), null, 2)}\n`, "utf8");
  return filePath;
}
