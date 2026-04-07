import { escapeHtml } from "./render-utils.js";

const memoryProfileStorageKey = "learning-loop-memory-profile-id";

const state = {
  session: null,
  baselines: []
};

const elements = {
  targetForm: document.querySelector("#target-form"),
  targetBaseline: document.querySelector("#target-baseline"),
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
  latestMemoryEvents: document.querySelector("#latest-memory-events"),
  masteryEmpty: document.querySelector("#mastery-empty"),
  masteryMap: document.querySelector("#mastery-map"),
  abilityDomains: document.querySelector("#ability-domains"),
  nextStepsEmpty: document.querySelector("#next-steps-empty"),
  nextSteps: document.querySelector("#next-steps"),
  revisitEmpty: document.querySelector("#revisit-empty"),
  revisitQueue: document.querySelector("#revisit-queue"),
  quickActionButtons: document.querySelectorAll("[data-answer-intent]"),
  targetMatchValue: document.querySelector("#target-match-value"),
  targetMatchLabel: document.querySelector("#target-match-label"),
  targetMatchBar: document.querySelector("#target-match-bar"),
  targetMatchExplanation: document.querySelector("#target-match-explanation")
};

function getMemoryProfileId() {
  return window.localStorage.getItem(memoryProfileStorageKey) || "";
}

function setMemoryProfileId(memoryProfileId) {
  if (memoryProfileId) {
    window.localStorage.setItem(memoryProfileStorageKey, memoryProfileId);
  }
}

function renderBaselines(baselines) {
  state.baselines = baselines;
  elements.targetBaseline.innerHTML = baselines
    .map(
      (baseline) =>
        `<option value="${baseline.id}">${baseline.title}${baseline.flagship ? "（Flagship）" : ""}</option>`
    )
    .join("");
}

function renderTargetMatch(targetMatch) {
  if (!targetMatch) {
    elements.targetMatchValue.textContent = "0%";
    elements.targetMatchLabel.textContent = "暂无估计";
    elements.targetMatchBar.style.width = "0%";
    elements.targetMatchExplanation.textContent = "";
    return;
  }

  const percent = targetMatch.percentage ?? targetMatch.percent ?? 0;
  elements.targetMatchValue.textContent = `${percent}%`;
  elements.targetMatchLabel.textContent = targetMatch.label;
  elements.targetMatchBar.style.width = `${percent}%`;
  elements.targetMatchExplanation.textContent = targetMatch.explanation;
}

function renderConceptList(concepts) {
  elements.conceptList.innerHTML = concepts
    .map((concept) => {
      const provenance = concept.provenance?.label || concept.provenanceLabel || concept.interviewQuestion?.label || "";
      const provenanceLabel = provenance ? `<span class="provenance-badge">${escapeHtml(provenance)}</span>` : "";
      return `<li>
        <strong>${escapeHtml(concept.title)}</strong> ${provenanceLabel}
        <br />
        <span>${escapeHtml(concept.summary)}</span>
        <br />
        <small>${escapeHtml(concept.diagnosticQuestion)}</small>
      </li>`;
    })
    .join("");
}

function renderMemoryEvents(events) {
  if (!events?.length) {
    elements.latestMemoryEvents.classList.add("hidden");
    elements.latestMemoryEvents.innerHTML = "";
    return;
  }

  elements.latestMemoryEvents.classList.remove("hidden");
  elements.latestMemoryEvents.innerHTML = events
    .map((event) => {
      const evidenceBits = [
        event.assessmentHandle ? `证据句柄：${escapeHtml(event.assessmentHandle)}` : "",
        event.evidenceReference ? `依据：${escapeHtml(event.evidenceReference)}` : ""
      ].filter(Boolean);

      return `<article class="memory-event">
        <div class="turn-meta">${escapeHtml(event.type.replaceAll("_", " · "))}</div>
        <div>${escapeHtml(event.summary || event.message)}</div>
        ${evidenceBits.length ? `<small class="muted-copy">${evidenceBits.join(" · ")}</small>` : ""}
      </article>`;
    })
    .join("");
}

function renderSession(session, latestFeedback = null) {
  state.session = session;

  elements.summaryEmpty.classList.add("hidden");
  elements.summaryContent.classList.remove("hidden");
  elements.probeEmpty.classList.add("hidden");
  elements.probeContent.classList.remove("hidden");

  elements.sourceTitle.textContent = session.targetBaseline?.title || session.source.title;
  elements.sourceFraming.textContent = session.summary.framing;
  elements.currentProbe.textContent = session.currentProbe;
  renderTargetMatch(session.targetMatch);
  renderConceptList(session.concepts);
  renderTurnHistory(session.turns || []);
  renderMemoryEvents(session.latestMemoryEvents || session.memoryEvents || []);
  renderMasteryMap(session.masteryMap || []);
  renderAbilityDomains(session.abilityDomains || []);
  renderNextSteps(session.nextSteps || []);
  renderRevisitQueue(session.revisitQueue || []);

  const answerPreference = elements.answerForm.querySelector('[name="interactionPreference"]');
  if (answerPreference) {
    answerPreference.value = session.interactionPreference || "balanced";
  }

  if (latestFeedback) {
    elements.latestFeedback.classList.remove("hidden");
    elements.latestFeedback.innerHTML = `
      <strong>${escapeHtml(latestFeedback.conceptTitle)}</strong>
      <div>${escapeHtml(latestFeedback.explanation)}</div>
      <div class="feedback-meta">
        <span class="state-chip">${escapeHtml(latestFeedback.judge.state)}</span>
        ${latestFeedback.evidenceReference ? `<span class="muted-copy">依据：${escapeHtml(latestFeedback.evidenceReference)}</span>` : ""}
      </div>
      ${
        latestFeedback.coachingStep
          ? `<div><strong>下一步：</strong>${escapeHtml(latestFeedback.coachingStep)}</div>`
          : ""
      }
      ${
        latestFeedback.teachingChunk
          ? `<div><strong>补充讲解：</strong>${escapeHtml(latestFeedback.teachingChunk)}</div>`
          : ""
      }
    `;
  }
}

function renderTurnHistory(turns) {
  elements.turnHistory.innerHTML = turns
    .map((turn) => {
      const meta = [turn.role === "tutor" ? "Tutor" : "你", turn.conceptTitle].filter(Boolean).join(" · ");
      return `<article class="turn-card ${turn.role}">
        <div class="turn-meta">${escapeHtml(meta)}</div>
        <div>${escapeHtml(turn.content)}</div>
      </article>`;
    })
    .join("");
}

function renderMasteryMap(masteryMap) {
  if (!masteryMap.length) {
    return;
  }

  elements.masteryEmpty.classList.add("hidden");
  elements.masteryMap.innerHTML = masteryMap
    .map((item) => {
      const evidenceText = item.evidence.length
        ? item.evidence.map((evidence) => `${evidence.signal}: ${evidence.explanation}`).join(" / ")
        : "暂无证据";
      return `<li>
        <strong>${escapeHtml(item.title)}</strong>
        <span class="state-chip">${escapeHtml(item.state)}</span>
        ${item.provenanceLabel ? `<span class="provenance-badge">${escapeHtml(item.provenanceLabel)}</span>` : ""}
        <div>${escapeHtml(item.reasons.join("；"))}</div>
        <small>${escapeHtml(evidenceText)}</small>
      </li>`;
    })
    .join("");
}

function renderAbilityDomains(domains) {
  elements.abilityDomains.innerHTML = domains
    .map(
      (domain) => `<section class="domain-card">
        <h4>${escapeHtml(domain.title)}</h4>
        <ul>
          ${domain.items
            .map(
              (item) =>
                `<li><strong>${escapeHtml(item.title)}</strong> <span class="state-chip">${escapeHtml(item.state)}</span> <small>${escapeHtml(item.evidenceCount)} 条证据</small></li>`
            )
            .join("")}
        </ul>
      </section>`
    )
    .join("");
}

function renderNextSteps(nextSteps) {
  if (!nextSteps?.length) {
    return;
  }

  elements.nextStepsEmpty.classList.add("hidden");
  elements.nextSteps.innerHTML = nextSteps
    .map((step) => {
      const materials = (step.materials || [])
        .map(
          (material) =>
            `<div class="material-card"><strong>${escapeHtml(material.title)}</strong><br /><small>${escapeHtml(material.description)}</small></div>`
        )
        .join("");
      return `<li>
        <strong>${escapeHtml(step.title)}</strong>
        <span class="state-chip">${escapeHtml(step.state || "")}</span>
        <div>${escapeHtml(step.recommendation)}</div>
        ${step.relatedInterviewPrompt ? `<small>关联题源：${escapeHtml(step.relatedInterviewPrompt)}</small>` : ""}
        ${materials ? `<div class="materials">${materials}</div>` : ""}
      </li>`;
    })
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
    .map((item) => `<li><strong>${escapeHtml(item.conceptTitle)}</strong><br />${escapeHtml(item.takeaway || item.reason)}</li>`)
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

async function fetchJson(url) {
  const response = await fetch(url);
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

elements.quickActionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await submitAnswerWithIntent(
        button.dataset.answerIntent === "teach"
          ? "讲一下"
          : button.dataset.answerIntent === "summarize"
            ? "总结一下"
            : "下一题"
      );
    } catch (error) {
      window.alert(error.message);
    }
  });
});

elements.targetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.targetForm);
  try {
    const session = await postJson("/api/session/start-target", {
      targetBaselineId: formData.get("targetBaselineId"),
      interactionPreference: formData.get("interactionPreference"),
      memoryProfileId: getMemoryProfileId()
    });
    setMemoryProfileId(session.memoryProfileId);
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
  try {
    const session = await postJson("/api/session/answer", {
      sessionId: state.session.sessionId,
      answer: formData.get("answer"),
      burdenSignal: formData.get("burdenSignal"),
      interactionPreference: formData.get("interactionPreference") || state.session.interactionPreference
    });
    elements.answerForm.reset();
    renderSession(session, session.latestFeedback);
    const answerPreference = elements.answerForm.querySelector('[name="interactionPreference"]');
    if (answerPreference) {
      answerPreference.value = session.interactionPreference || "balanced";
    }
  } catch (error) {
    window.alert(error.message);
  }
});

async function bootstrap() {
  try {
    const data = await fetchJson("/api/baselines");
    renderBaselines(data.baselines || []);
  } catch (error) {
    window.alert(error.message);
  }
}

bootstrap();
