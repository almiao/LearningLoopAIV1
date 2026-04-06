const state = {
  sourceTab: "document",
  session: null
};

const elements = {
  sourceTabs: document.querySelectorAll("[data-source-tab]"),
  documentForm: document.querySelector("#document-form"),
  urlForm: document.querySelector("#url-form"),
  answerForm: document.querySelector("#answer-form"),
  summaryEmpty: document.querySelector("#summary-empty"),
  summaryContent: document.querySelector("#summary-content"),
  sourceTitle: document.querySelector("#source-title"),
  sourceFraming: document.querySelector("#source-framing"),
  conceptList: document.querySelector("#concept-list"),
  probeEmpty: document.querySelector("#probe-empty"),
  probeContent: document.querySelector("#probe-content"),
  currentProbe: document.querySelector("#current-probe"),
  turnHistory: document.querySelector("#turn-history"),
  latestFeedback: document.querySelector("#latest-feedback"),
  masteryEmpty: document.querySelector("#mastery-empty"),
  masteryMap: document.querySelector("#mastery-map"),
  nextStepsEmpty: document.querySelector("#next-steps-empty"),
  nextSteps: document.querySelector("#next-steps"),
  revisitEmpty: document.querySelector("#revisit-empty"),
  revisitQueue: document.querySelector("#revisit-queue"),
  quickActionButtons: document.querySelectorAll("[data-answer-intent]")
};

function switchSourceTab(nextTab) {
  state.sourceTab = nextTab;
  elements.sourceTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.sourceTab === nextTab);
  });
  elements.documentForm.classList.toggle("active", nextTab === "document");
  elements.urlForm.classList.toggle("active", nextTab === "url");
}

function renderSession(session, latestFeedback = null) {
  state.session = session;

  elements.summaryEmpty.classList.add("hidden");
  elements.summaryContent.classList.remove("hidden");
  elements.probeEmpty.classList.add("hidden");
  elements.probeContent.classList.remove("hidden");

  elements.sourceTitle.textContent = session.source.title;
  elements.sourceFraming.textContent = session.summary.framing;
  elements.currentProbe.textContent = session.currentProbe;
  const answerPreference = elements.answerForm.querySelector('[name="interactionPreference"]');
  if (answerPreference) {
    answerPreference.value = session.interactionPreference || "balanced";
  }

  elements.conceptList.innerHTML = session.concepts
    .map(
      (concept) =>
        `<li>
          <strong>${concept.title}</strong>
          <br />
          <span>${concept.summary}</span>
          <br />
          <small>可先检查：${concept.diagnosticQuestion}</small>
        </li>`
    )
    .join("");
  renderTurnHistory(session.turns || []);

  if (latestFeedback) {
    elements.latestFeedback.classList.remove("hidden");
    const hasInternalAnalysis = Boolean(
      latestFeedback.strength ||
      latestFeedback.gap ||
      latestFeedback.teachingChunk ||
      latestFeedback.evidenceReference ||
      latestFeedback.coachingStep
    );
    elements.latestFeedback.innerHTML = `
      <strong>${latestFeedback.conceptTitle}</strong>
      <div>${latestFeedback.explanation}</div>
      ${
        hasInternalAnalysis
          ? `
            <details class="analysis-details">
              <summary>展开 AI 分析</summary>
              ${latestFeedback.strength ? `<div><strong>已确认：</strong>${latestFeedback.strength}</div>` : ""}
              ${latestFeedback.gap ? `<div><strong>当前缺口：</strong>${latestFeedback.gap}</div>` : ""}
              ${
                latestFeedback.teachingChunk
                  ? `<div><strong>补充讲解：</strong>${latestFeedback.teachingChunk}</div>`
                  : ""
              }
              ${
                latestFeedback.takeaway
                  ? `<div><strong>这一轮带走：</strong>${latestFeedback.takeaway}</div>`
                  : ""
              }
              ${
                latestFeedback.revisitReason
                  ? `<div><strong>后续回访：</strong>${latestFeedback.revisitReason}</div>`
                  : ""
              }
              ${
                latestFeedback.evidenceReference
                  ? `<div><strong>材料依据：</strong>${latestFeedback.evidenceReference}</div>`
                  : ""
              }
              ${
                latestFeedback.coachingStep
                  ? `<div><strong>后续引导：</strong>${latestFeedback.coachingStep}</div>`
                  : ""
              }
            </details>
          `
          : ""
      }
      <div class="state-chip">${latestFeedback.judge.state}</div>
      <div>${latestFeedback.judge.reasons.join("；")}</div>
    `;
  }

  renderMasteryMap(session.masteryMap);
  renderNextSteps(session.nextSteps);
  renderRevisitQueue(session.revisitQueue || []);
}

function renderTurnHistory(turns) {
  if (!turns.length) {
    elements.turnHistory.innerHTML = "";
    return;
  }

  elements.turnHistory.innerHTML = turns
    .map((turn) => {
      const meta = [turn.role === "tutor" ? "Tutor" : "你", turn.conceptTitle]
        .filter(Boolean)
        .join(" · ");
      const hasInternalAnalysis = Boolean(
        turn.strength || turn.gap || turn.teachingChunk || turn.evidenceReference || turn.coachingStep
      );

      return `
        <article class="turn-card ${turn.role}">
          <div class="turn-meta">${meta}</div>
          <div>${turn.content}</div>
          ${
            hasInternalAnalysis
              ? `
                <details class="analysis-details">
                  <summary>展开 AI 分析</summary>
                  ${turn.strength ? `<div><strong>已确认：</strong>${turn.strength}</div>` : ""}
                  ${turn.gap ? `<div><strong>当前缺口：</strong>${turn.gap}</div>` : ""}
                  ${turn.teachingChunk ? `<div><strong>补充讲解：</strong>${turn.teachingChunk}</div>` : ""}
                  ${turn.takeaway ? `<div><strong>这一轮带走：</strong>${turn.takeaway}</div>` : ""}
                  ${turn.revisitReason ? `<div><strong>后续回访：</strong>${turn.revisitReason}</div>` : ""}
                  ${turn.evidenceReference ? `<div><strong>材料依据：</strong>${turn.evidenceReference}</div>` : ""}
                  ${turn.coachingStep ? `<div><strong>后续引导：</strong>${turn.coachingStep}</div>` : ""}
                </details>
              `
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function renderMasteryMap(masteryMap) {
  if (!masteryMap?.length) {
    return;
  }

  elements.masteryEmpty.classList.add("hidden");
  elements.masteryMap.innerHTML = masteryMap
    .map((item) => {
      const evidenceText = item.evidence.length
        ? item.evidence.map((evidence) => `${evidence.signal}: ${evidence.explanation}`).join(" / ")
        : "暂无证据";

      return `
        <li>
          <strong>${item.title}</strong>
          <span class="state-chip">${item.state}</span>
          <div>${item.reasons.join("；")}</div>
          <small>${evidenceText}</small>
        </li>
      `;
    })
    .join("");
}

function renderNextSteps(nextSteps) {
  if (!nextSteps?.length) {
    return;
  }

  elements.nextStepsEmpty.classList.add("hidden");
  elements.nextSteps.innerHTML = nextSteps
    .map((step) => `<li><strong>${step.title}</strong><br />${step.recommendation}</li>`)
    .join("");
}

function renderRevisitQueue(revisitQueue) {
  const pending = (revisitQueue || []).filter((item) => !item.done);
  if (!pending.length) {
    elements.revisitEmpty.classList.remove("hidden");
    elements.revisitQueue.innerHTML = "";
    return;
  }

  elements.revisitEmpty.classList.add("hidden");
  elements.revisitQueue.innerHTML = pending
    .map((item) => `<li><strong>${item.conceptTitle}</strong><br />${item.takeaway || item.reason}</li>`)
    .join("");
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function submitAnswerWithIntent(intent) {
  if (!state.session) {
    return;
  }

  const formData = new FormData(elements.answerForm);
  const payload = {
    sessionId: state.session.sessionId,
    answer: intent,
    burdenSignal: formData.get("burdenSignal"),
    interactionPreference: formData.get("interactionPreference") || state.session.interactionPreference
  };

  const session = await postJson("/api/session/answer", payload);
  renderSession(session, session.latestFeedback);
}

elements.sourceTabs.forEach((button) => {
  button.addEventListener("click", () => {
    switchSourceTab(button.dataset.sourceTab);
  });
});

elements.quickActionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await submitAnswerWithIntent(button.dataset.answerIntent === "teach"
        ? "讲一下"
        : button.dataset.answerIntent === "summarize"
          ? "总结一下"
          : "下一题");
    } catch (error) {
      window.alert(error.message);
    }
  });
});

elements.documentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.documentForm);
  const payload = {
    type: "document",
    title: formData.get("title"),
    content: formData.get("content"),
    interactionPreference: formData.get("interactionPreference")
  };

  try {
    const session = await postJson("/api/source/analyze", payload);
    renderSession(session);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.urlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.urlForm);
  const payload = {
    type: "url",
    url: formData.get("url"),
    interactionPreference: formData.get("interactionPreference")
  };

  try {
    const session = await postJson("/api/source/analyze", payload);
    renderSession(session);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.answerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.session) {
    return;
  }

  const formData = new FormData(elements.answerForm);
  const payload = {
    sessionId: state.session.sessionId,
    answer: formData.get("answer"),
    burdenSignal: formData.get("burdenSignal"),
    interactionPreference: formData.get("interactionPreference") || state.session.interactionPreference
  };

  try {
    const session = await postJson("/api/session/answer", payload);
    elements.answerForm.reset();
    renderSession(session, session.latestFeedback);
    const answerPreferenceAfterReset = elements.answerForm.querySelector('[name="interactionPreference"]');
    if (answerPreferenceAfterReset) {
      answerPreferenceAfterReset.value = session.interactionPreference || "balanced";
    }
  } catch (error) {
    window.alert(error.message);
  }
});

switchSourceTab("document");
