import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../../src/server.js";
import { createHeuristicTutorIntelligence } from "../../src/tutor/tutor-intelligence.js";

async function withServer(fn) {
  const server = createAppServer({
    intelligence: createHeuristicTutorIntelligence()
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("http workspace flow supports target start, domain focus, concept focus, and answer loop", async () => {
  await withServer(async (baseUrl) => {
    const home = await fetch(baseUrl);
    const html = await home.text();
    assert.match(html, /Workspace 导航/);
    assert.match(html, /开始该域测评/);

    const baselinesResponse = await fetch(`${baseUrl}/api/baselines`);
    const baselinesPayload = await baselinesResponse.json();
    assert.equal(baselinesPayload.baselines.length, 1);
    assert.equal(baselinesPayload.baselines[0].id, "bigtech-java-backend");

    const sessionResponse = await fetch(`${baseUrl}/api/session/start-target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetBaselineId: "bigtech-java-backend",
        interactionPreference: "balanced"
      })
    });
    const session = await sessionResponse.json();
    assert.equal(session.targetBaseline.id, "bigtech-java-backend");
    assert.ok(Array.isArray(session.summary.overviewDomains));

    const domainFocusResponse = await fetch(`${baseUrl}/api/session/focus-domain`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        domainId: "network-http-tcp"
      })
    });
    const domainFocused = await domainFocusResponse.json();
    assert.equal(domainFocused.currentConceptId, "tcp-handshake-backlog-timewait");

    const conceptFocusResponse = await fetch(`${baseUrl}/api/session/focus-concept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        conceptId: "jvm-memory-gc-basics"
      })
    });
    const conceptFocused = await conceptFocusResponse.json();
    assert.equal(conceptFocused.currentConceptId, "jvm-memory-gc-basics");

    const answerResponse = await fetch(`${baseUrl}/api/session/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        answer: "JVM 里对象通常先在新生代分配，GC 分代是为了让短命对象更高效被回收。",
        burdenSignal: "normal",
        interactionPreference: "balanced"
      })
    });
    const answered = await answerResponse.json();
    assert.ok(answered.latestFeedback);
    assert.ok(answered.targetMatch.percentage > 0);
  });
});
