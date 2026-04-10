import { escapeHtml } from "./render-utils.js";
import { buildWorkspaceHash, parseWorkspaceHash } from "./workspace-route.js";

const memoryProfileStorageKey = "learning-loop-memory-profile-id";
const userIdStorageKey = "learning-loop-user-id";

const state = {
  user: null,
  profile: null,
  session: null,
  baselines: [],
  selectedDomainId: "",
  selectedConceptId: "",
  currentPage: "overview",
  entryMode: "test-first"
};

const elements = {
  authForm: document.querySelector("#auth-form"),
  authGuest: document.querySelector("#auth-guest"),
  authUser: document.querySelector("#auth-user"),
  authHandle: document.querySelector("#auth-handle"),
  authPin: document.querySelector("#auth-pin"),
  profileHandle: document.querySelector("#profile-handle"),
  profileCopy: document.querySelector("#profile-copy"),
  profileSummary: document.querySelector("#profile-summary"),
  profileTargets: document.querySelector("#profile-targets"),
  profileTargetsEmpty: document.querySelector("#profile-targets-empty"),
  refreshProfile: document.querySelector("#refresh-profile"),
  signOut: document.querySelector("#sign-out"),
  targetForm: document.querySelector("#target-form"),
  targetFormNote: document.querySelector("#target-form-note"),
  targetBaseline: document.querySelector("#target-baseline"),
  entryMode: document.querySelector("#entry-mode"),
  answerForm: document.querySelector("#answer-form"),
  workspaceShell: document.querySelector("#workspace-shell"),
  workspaceScopeCopy: document.querySelector("#workspace-scope-copy"),
  startBaselineAssessment: document.querySelector("#start-baseline-assessment"),
  openReadingView: document.querySelector("#open-reading-view"),
  openMemoryView: document.querySelector("#open-memory-view"),
  workspaceTabs: document.querySelectorAll("[data-page-nav]"),
  summaryEmpty: document.querySelector("#summary-empty"),
  summaryContent: document.querySelector("#summary-content"),
  sourceTitle: document.querySelector("#source-title"),
  sourceFraming: document.querySelector("#source-framing"),
  overviewDomains: document.querySelector("#overview-domains"),
  selectedDomainContext: document.querySelector("#selected-domain-context"),
  selectedDomainCopy: document.querySelector("#selected-domain-copy"),
  startDomainAssessment: document.querySelector("#start-domain-assessment"),
  readDomainMaterials: document.querySelector("#read-domain-materials"),
  viewDomainMemory: document.querySelector("#view-domain-memory"),
  conceptListTitle: document.querySelector("#concept-list-title"),
  conceptListSubtitle: document.querySelector("#concept-list-subtitle"),
  conceptList: document.querySelector("#concept-list"),
  probeEmpty: document.querySelector("#probe-empty"),
  probeContent: document.querySelector("#probe-content"),
  currentProbe: document.querySelector("#current-probe"),
  turnHistory: document.querySelector("#turn-history"),
  latestFeedback: document.querySelector("#latest-feedback"),
  latestMemoryEvents: document.querySelector("#latest-memory-events"),
  runtimeMapPanel: document.querySelector("#runtime-map-panel"),
  runtimeMapContent: document.querySelector("#runtime-map-content"),
  masteryEmpty: document.querySelector("#mastery-empty"),
  masteryMap: document.querySelector("#mastery-map"),
  abilityDomains: document.querySelector("#ability-domains"),
  nextStepsEmpty: document.querySelector("#next-steps-empty"),
  materialsSources: document.querySelector("#materials-sources"),
  nextSteps: document.querySelector("#next-steps"),
  revisitEmpty: document.querySelector("#revisit-empty"),
  revisitQueue: document.querySelector("#revisit-queue"),
  quickActionButtons: document.querySelectorAll("[data-answer-intent]"),
  targetMatchValue: document.querySelector("#target-match-value"),
  targetMatchLabel: document.querySelector("#target-match-label"),
  targetMatchBar: document.querySelector("#target-match-bar"),
  targetMatchExplanation: document.querySelector("#target-match-explanation"),
  memoryPanel: document.querySelector("#memory-panel"),
  materialsPanel: document.querySelector("#materials-panel"),
  summaryPanel: document.querySelector("#summary-panel"),
  probePanel: document.querySelector("#probe-panel"),
  pagePanels: document.querySelectorAll("[data-page-group]"),
  gridContainers: document.querySelectorAll(".grid")
};

let hashSyncMuted = false;

function getMemoryProfileId() {
  return window.localStorage.getItem(memoryProfileStorageKey) || "";
}

function setMemoryProfileId(memoryProfileId) {
  if (memoryProfileId) {
    window.localStorage.setItem(memoryProfileStorageKey, memoryProfileId);
  }
}

function getUserId() {
  return window.localStorage.getItem(userIdStorageKey) || "";
}

function setUserId(userId) {
  if (userId) {
    window.localStorage.setItem(userIdStorageKey, userId);
  }
}

function clearUserState() {
  window.localStorage.removeItem(userIdStorageKey);
  window.localStorage.removeItem(memoryProfileStorageKey);
  state.user = null;
  state.profile = null;
  state.session = null;
  state.selectedDomainId = "";
  state.selectedConceptId = "";
}

function renderMultilineText(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function renderInlineList(items = []) {
  return items
    .filter(Boolean)
    .map((item) => `<span class="inline-chip">${escapeHtml(item)}</span>`)
    .join("");
}

function renderQuestionSource(questionMeta = null) {
  if (!questionMeta || questionMeta.type !== "provenance-backed" || !questionMeta.label) {
    return "";
  }

  const companyPrefix = questionMeta.company ? `${questionMeta.company} · ` : "";
  return `<span class="question-source-link" title="${escapeHtml(questionMeta.label)}">面经来源：${escapeHtml(companyPrefix + questionMeta.label)}</span>`;
}

function renderQuestionText(content, questionMeta = null) {
  const source = renderQuestionSource(questionMeta);
  if (!source) {
    return escapeHtml(content || "");
  }

  return `${escapeHtml(content || "")} ${source}`;
}

function summarizeTurnResolution(turnResolution = null) {
  if (!turnResolution) {
    return "";
  }
  if (turnResolution.mode === "stay") {
    return "继续围绕当前点推进";
  }
  if (turnResolution.mode === "switch") {
    return `切到下一个点：${turnResolution.finalConceptTitle || "下一题"}`;
  }
  if (turnResolution.mode === "stop") {
    return "这一轮先收口";
  }
  return "";
}

function formatInfoGainLabel(level = "") {
  if (level === "high") {
    return "信息增量高";
  }
  if (level === "medium") {
    return "信息增量中";
  }
  if (level === "low") {
    return "信息增量低";
  }
  if (level === "negligible") {
    return "信息增量接近耗尽";
  }

  return "";
}

function summarizeWritebackMode(mode = "") {
  if (mode === "update") {
    return "更新长期记忆";
  }
  if (mode === "append_conflict") {
    return "追加冲突证据";
  }
  if (mode === "noop") {
    return "暂不写回";
  }

  return "";
}

function applyRouteToState(route) {
  state.currentPage = route.page || "overview";
  state.selectedDomainId = route.domainId || "";
  state.selectedConceptId = route.conceptId || "";
  state.entryMode = route.entryMode || "test-first";
  if (elements.entryMode) {
    elements.entryMode.value = state.entryMode;
  }
}

function syncHashFromState() {
  const nextHash = buildWorkspaceHash({
    page: state.currentPage,
    sessionId: state.session?.sessionId || "",
    domainId: state.selectedDomainId,
    conceptId: state.selectedConceptId,
    entryMode: state.entryMode
  });

  if (window.location.hash === nextHash) {
    return;
  }

  hashSyncMuted = true;
  window.location.hash = nextHash;
  queueMicrotask(() => {
    hashSyncMuted = false;
  });
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

function updateTargetAccessState() {
  const loggedIn = Boolean(state.user?.id);
  const submitButton = elements.targetForm?.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = !loggedIn;
  }
  if (elements.targetFormNote) {
    elements.targetFormNote.textContent = loggedIn
      ? "当前目标会自动写入你的学习档案，并沿用同一份长期记忆。"
      : "请先登录，目标、记忆和测评进展才会绑定到你的档案。";
  }
}

function renderProfileSummary(summary = {}) {
  const cards = [
    { label: "目标数", value: summary.totalTargets ?? 0 },
    { label: "累计会话", value: summary.sessionsStarted ?? 0 },
    { label: "已评估能力项", value: summary.assessedAbilityItems ?? 0 },
    { label: "Solid", value: summary.solidItems ?? 0 },
    { label: "Partial", value: summary.partialItems ?? 0 },
    { label: "Weak", value: summary.weakItems ?? 0 }
  ];

  elements.profileSummary.innerHTML = cards
    .map(
      (card) => `<article class="profile-summary-card">
        <div class="mini-label">${escapeHtml(card.label)}</div>
        <strong>${escapeHtml(String(card.value))}</strong>
      </article>`
    )
    .join("");
}

function renderProfileTargets(targets = []) {
  if (!targets.length) {
    elements.profileTargetsEmpty.classList.remove("hidden");
    elements.profileTargets.innerHTML = "";
    return;
  }

  elements.profileTargetsEmpty.classList.add("hidden");
  elements.profileTargets.innerHTML = targets
    .map(
      (target) => `<article class="profile-target-card">
        <div class="match-strip">
          <div>
            <div class="mini-label">目标</div>
            <h3>${escapeHtml(target.title)}</h3>
            <p class="muted-copy">${escapeHtml(target.targetRole || "")}</p>
          </div>
          <div class="match-card compact-match-card">
            <div class="mini-label">完成度</div>
            <div class="match-row">
              <strong>${escapeHtml(String(target.completionPercentage || 0))}%</strong>
              <span class="state-chip">${escapeHtml(target.completionLabel || "进行中")}</span>
            </div>
            <p class="muted-copy">已评估 ${escapeHtml(String(target.assessedItemCount || 0))} / ${escapeHtml(String(target.totalItemCount || 0))} 个能力项</p>
            <p class="muted-copy">已启动 ${escapeHtml(String(target.sessionsStarted || 0))} 次</p>
          </div>
        </div>
        <div class="profile-domain-list">
          ${(target.domains || [])
            .map(
              (domain) => `<section class="profile-domain-card">
                <div class="match-row">
                  <strong>${escapeHtml(domain.title)}</strong>
                  <span class="state-chip">${escapeHtml(String(domain.progressPercentage || 0))}%</span>
                </div>
                <small class="muted-copy">已评估 ${escapeHtml(String(domain.assessedItemCount || 0))} / ${escapeHtml(String(domain.totalItemCount || 0))}</small>
                <ul class="profile-item-list">
                  ${(domain.items || [])
                    .map(
                      (item) => `<li>
                        <strong>${escapeHtml(item.title)}</strong>
                        <span class="state-chip">${escapeHtml(item.state || "不可判")}</span>
                        <small>${escapeHtml(String(item.progressPercentage || 0))}% · ${escapeHtml(String(item.evidenceCount || 0))} 条证据</small>
                      </li>`
                    )
                    .join("")}
                </ul>
              </section>`
            )
            .join("")}
        </div>
      </article>`
    )
    .join("");
}

function renderAuthState() {
  const loggedIn = Boolean(state.user?.id);
  elements.authGuest.classList.toggle("hidden", loggedIn);
  elements.authUser.classList.toggle("hidden", !loggedIn);
  updateTargetAccessState();

  if (!loggedIn) {
    elements.profileHandle.textContent = "";
    elements.profileCopy.textContent = "";
    elements.profileSummary.innerHTML = "";
    elements.profileTargets.innerHTML = "";
    elements.profileTargetsEmpty.classList.remove("hidden");
    elements.workspaceShell.classList.add("hidden");
    return;
  }

  elements.profileHandle.textContent = state.user.handle;
  elements.profileCopy.textContent = `学习档案已绑定，目标、记忆和测评结果都会沿用同一份长期记录。`;
  renderProfileSummary(state.profile?.summary || {});
  renderProfileTargets(state.profile?.targets || []);
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

function getSelectedDomain(session) {
  if (!state.selectedDomainId) {
    return null;
  }

  return (session.summary?.overviewDomains || []).find((domain) => domain.id === state.selectedDomainId) || null;
}

function getSelectedConcept(session) {
  if (!state.selectedConceptId) {
    return null;
  }

  return (session.concepts || []).find((concept) => concept.id === state.selectedConceptId) || null;
}

function getVisibleConcepts(session) {
  if (state.selectedConceptId) {
    return (session.concepts || []).filter((concept) => concept.id === state.selectedConceptId);
  }

  if (!state.selectedDomainId) {
    return session.concepts || [];
  }

  return (session.concepts || []).filter(
    (concept) => (concept.abilityDomainId || concept.domainId) === state.selectedDomainId
  );
}

function renderConceptList(session) {
  const concepts = getVisibleConcepts(session);
  const selectedDomain = getSelectedDomain(session);
  const selectedConcept = getSelectedConcept(session);
  elements.conceptListTitle.textContent = selectedDomain
    ? `${selectedDomain.title} · 能力点`
    : "当前能力点切入";
  elements.conceptListSubtitle.textContent = selectedDomain
    ? selectedDomain.tier === "secondary"
      ? `当前只看 ${selectedDomain.title} 这个扩展能力域下的能力点。它有必要，但不属于首轮冷启动最高优先级。`
      : `当前只看 ${selectedDomain.title} 这个核心能力域下的能力点。`
    : selectedConcept
      ? `当前聚焦在“${selectedConcept.title}”这个具体能力项。`
      : "这里展示当前目标包下可诊断的能力点。";

  elements.conceptList.innerHTML = concepts
    .map((concept) => {
      const provenance = concept.provenance?.label || concept.provenanceLabel || concept.interviewQuestion?.label || "";
      const provenanceLabel = provenance ? `<span class="provenance-badge">${escapeHtml(provenance)}</span>` : "";
      const guideSources = (concept.javaGuideSources || [])
        .map(
          (source) =>
            `<a class="guide-link" href="${encodeURI(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>`
        )
        .join("");
      const guideSourceRow = guideSources
        ? `<div class="guide-link-row"><span class="muted-copy">JavaGuide：</span>${guideSources}</div>`
        : "";
      return `<li>
        <strong>${escapeHtml(concept.title)}</strong> ${provenanceLabel}
        <br />
        <span>${escapeHtml(concept.summary)}</span>
        <br />
        <small>${escapeHtml(concept.diagnosticQuestion)}</small>
        ${guideSourceRow}
        <div class="quick-actions concept-actions">
          <button type="button" data-concept-action="assess" data-concept-id="${escapeHtml(concept.id)}">测这个点</button>
          <button type="button" data-concept-action="read" data-concept-id="${escapeHtml(concept.id)}">读这个点</button>
        </div>
      </li>`;
    })
    .join("");
}

function getVisibleGuideSources(session) {
  const concepts = getVisibleConcepts(session);
  const unique = new Map();

  for (const concept of concepts) {
    for (const source of concept.javaGuideSources || []) {
      unique.set(source.path || source.url, source);
    }
  }

  return unique.size > 0 ? [...unique.values()] : session.summary.javaGuideSourceClusters || [];
}

function renderMaterialsSources(sources) {
  if (!sources?.length) {
    elements.materialsSources.innerHTML = "";
    return;
  }

  elements.materialsSources.innerHTML = sources
    .map(
      (source) =>
        `<a class="guide-link" href="${encodeURI(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>`
    )
    .join("");
}

function renderOverviewDomains(domains) {
  if (!domains?.length) {
    elements.overviewDomains.innerHTML = "";
    return;
  }

  elements.overviewDomains.innerHTML = domains
    .slice()
    .sort((left, right) => {
      const leftTier = left.tier === "secondary" ? 1 : 0;
      const rightTier = right.tier === "secondary" ? 1 : 0;
      return leftTier - rightTier;
    })
    .map(
      (domain) => `<button type="button" class="domain-card domain-button ${state.selectedDomainId === domain.id ? "active" : ""}" data-domain-id="${escapeHtml(domain.id)}">
        <h4>${escapeHtml(domain.title)}${domain.tier === "secondary" ? ' <span class="tier-chip">扩展</span>' : ""}</h4>
        <div class="muted-copy">${escapeHtml(domain.itemCount)} 个能力项</div>
        <small>${escapeHtml((domain.sampleItems || []).join("、"))}</small>
      </button>`
    )
    .join("");
}

function renderSelectedDomainContext(session) {
  const selectedDomain = getSelectedDomain(session);
  const selectedConcept = getSelectedConcept(session);
  if (selectedConcept) {
    elements.selectedDomainContext.classList.remove("hidden");
    elements.selectedDomainCopy.textContent = `你当前聚焦在“${selectedConcept.title}”这个具体能力项。现在可以直接测这个点、读这个点的资料，或者回到上一级能力域。`;
    return;
  }

  if (!selectedDomain) {
    elements.selectedDomainContext.classList.add("hidden");
    elements.selectedDomainCopy.textContent = "";
    return;
  }

  elements.selectedDomainContext.classList.remove("hidden");
  elements.selectedDomainCopy.textContent =
    selectedDomain.tier === "secondary"
      ? `你当前选中了“${selectedDomain.title}”。这个域在首版里属于扩展能力域。当前模式是${state.entryMode === "learn-first" ? "先学后测" : "先测后学"}。`
      : `你当前选中了“${selectedDomain.title}”。当前模式是${state.entryMode === "learn-first" ? "先学后测" : "先测后学"}。你可以直接进入该域工作流。`;
}

function renderPageShell() {
  elements.pagePanels.forEach((panel) => {
    const groups = (panel.dataset.pageGroup || "").split(/\s+/).filter(Boolean);
    panel.classList.toggle("hidden", !groups.includes(state.currentPage));
  });
  elements.gridContainers.forEach((grid) => {
    const visibleCount = [...grid.children].filter((child) => !child.classList.contains("hidden")).length;
    grid.classList.toggle("single-panel", visibleCount <= 1);
  });
  elements.workspaceTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.pageNav === state.currentPage);
  });
  syncHashFromState();
}

function getCurrentScopeLabel(session) {
  const selectedConcept = getSelectedConcept(session);
  if (selectedConcept) {
    return `当前工作对象：能力项“${selectedConcept.title}”`;
  }

  const selectedDomain = getSelectedDomain(session);
  if (selectedDomain) {
    return `当前工作对象：能力域“${selectedDomain.title}”`;
  }

  return `当前工作对象：目标包“${session.targetBaseline?.title || session.source.title}”`;
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

function renderRuntimeMap(session, latestFeedback = null) {
  const runtimeMap = latestFeedback?.runtimeMap || session.currentRuntimeMap;
  const nextMove = latestFeedback?.nextMove || null;
  const writebackSuggestion = latestFeedback?.writebackSuggestion || null;
  const currentMemoryAnchor = session.currentMemoryAnchor || null;

  if (!runtimeMap) {
    elements.runtimeMapPanel.classList.add("hidden");
    elements.runtimeMapContent.innerHTML = "";
    return;
  }

  const hypothesisChips = renderInlineList(
    (runtimeMap.hypotheses || [])
      .filter((item) => item.status === "supported" || item.status === "contradicted")
      .map((item) => item.note || item.label || item.id)
  );
  const misunderstandingChips = renderInlineList(
    (runtimeMap.misunderstandings || []).map((item) => item.label || item.note || "")
  );
  const openQuestions = (runtimeMap.open_questions || [])
    .map((question) => `<li>${escapeHtml(question)}</li>`)
    .join("");

  elements.runtimeMapPanel.classList.remove("hidden");
  elements.runtimeMapContent.innerHTML = `
    <div class="feedback-meta">
      <span class="state-chip">${escapeHtml(runtimeMap.anchor_assessment?.state || "不可判")}</span>
      <span class="muted-copy">置信等级：${escapeHtml(runtimeMap.anchor_assessment?.confidence_level || "low")}</span>
      ${
        runtimeMap.info_gain_level
          ? `<span class="muted-copy">${escapeHtml(formatInfoGainLabel(runtimeMap.info_gain_level))}</span>`
          : ""
      }
    </div>
    ${
      runtimeMap.anchor_assessment?.reasons?.length
        ? runtimeMap.anchor_assessment.reasons.map((reason) => `<div>${escapeHtml(reason)}</div>`).join("")
        : ""
    }
    ${hypothesisChips ? `<div class="insight-row"><strong>已确认</strong>${hypothesisChips}</div>` : ""}
    ${misunderstandingChips ? `<div class="insight-row"><strong>当前误区</strong>${misunderstandingChips}</div>` : ""}
    ${
      openQuestions
        ? `<details class="analysis-details"><summary>还要继续验证什么</summary><ul>${openQuestions}</ul></details>`
        : ""
    }
    ${
      nextMove
        ? `<div class="callout subtle-callout">
            <span class="tag">下一步动作</span>
            <div><strong>${escapeHtml(nextMove.intent || "")}</strong></div>
            <small class="muted-copy">${escapeHtml(nextMove.reason || "")}</small>
          </div>`
        : ""
    }
    ${
      writebackSuggestion
        ? `<div class="callout subtle-callout">
            <span class="tag">长期记忆写回</span>
            <div>${
              writebackSuggestion.should_write
                ? `这轮会尝试${escapeHtml(summarizeWritebackMode(writebackSuggestion.mode))}`
                : "这轮先不写回长期记忆"
            }</div>
            ${
              writebackSuggestion.anchorPatch?.derivedPrinciple || writebackSuggestion.anchor_patch?.derived_principle
                ? `<small class="muted-copy">${escapeHtml(
                    writebackSuggestion.anchorPatch?.derivedPrinciple ||
                      writebackSuggestion.anchor_patch?.derived_principle
                  )}</small>`
                : ""
            }
          </div>`
        : currentMemoryAnchor?.derivedPrinciple
          ? `<div class="callout subtle-callout">
              <span class="tag">当前长期记忆摘要</span>
              <small class="muted-copy">${escapeHtml(currentMemoryAnchor.derivedPrinciple)}</small>
            </div>`
          : ""
    }
    ${
      latestFeedback?.controlVerdict
        ? `<div class="callout subtle-callout">
            <span class="tag">控制层裁决</span>
            <div>${
              latestFeedback.controlVerdict.should_stop
                ? "这一轮已经满足收口条件。"
                : "这一轮仍允许继续推进。"
            }</div>
            <small class="muted-copy">原因：${escapeHtml(latestFeedback.controlVerdict.reason || "continue")}</small>
          </div>`
        : ""
    }
  `;
}

function renderSession(session, latestFeedback = null) {
  state.session = session;
  if (state.selectedConceptId && !(session.concepts || []).some((concept) => concept.id === state.selectedConceptId)) {
    state.selectedConceptId = "";
  }
  if (
    state.selectedDomainId &&
    !(session.summary?.overviewDomains || []).some((domain) => domain.id === state.selectedDomainId)
  ) {
    state.selectedDomainId = "";
  }

  elements.workspaceShell.classList.remove("hidden");
  elements.workspaceScopeCopy.textContent = getCurrentScopeLabel(session);
  elements.summaryEmpty.classList.add("hidden");
  elements.summaryContent.classList.remove("hidden");
  elements.probeEmpty.classList.add("hidden");
  elements.probeContent.classList.remove("hidden");

  elements.sourceTitle.textContent = session.targetBaseline?.title || session.source.title;
  elements.sourceFraming.textContent = session.summary.framing;
  elements.currentProbe.innerHTML = renderQuestionText(session.currentProbe, session.currentQuestionMeta);
  renderTargetMatch(session.targetMatch);
  renderOverviewDomains(session.summary.overviewDomains || []);
  renderSelectedDomainContext(session);
  renderMaterialsSources(getVisibleGuideSources(session));
  renderConceptList(session);
  renderTurnHistory(session.turns || []);
  renderMemoryEvents(session.latestMemoryEvents || session.memoryEvents || []);
  renderRuntimeMap(session, latestFeedback);
  renderMasteryMap(session.masteryMap || [], state.selectedDomainId);
  renderAbilityDomains(session.abilityDomains || [], state.selectedDomainId);
  renderNextSteps(session.nextSteps || [], state.selectedDomainId, session.concepts || []);
  renderRevisitQueue(session.revisitQueue || [], state.selectedDomainId, session.concepts || []);
  renderPageShell();

  const answerPreference = elements.answerForm.querySelector('[name="interactionPreference"]');
  if (answerPreference) {
    answerPreference.value = session.interactionPreference || "balanced";
  }
  if (elements.entryMode) {
    elements.entryMode.value = state.entryMode;
  }

  if (latestFeedback) {
    elements.latestFeedback.classList.remove("hidden");
    const summaryBits = [
      latestFeedback.strength ? `这次确认了：${latestFeedback.strength}` : "",
      latestFeedback.gap ? `当前缺口：${latestFeedback.gap}` : "",
      latestFeedback.takeaway ? `带走一句话：${latestFeedback.takeaway}` : ""
    ].filter(Boolean);
    elements.latestFeedback.innerHTML = `
      <strong>本轮判断与记忆更新 · ${escapeHtml(latestFeedback.conceptTitle)}</strong>
      <div class="feedback-meta">
        <span class="state-chip">${escapeHtml(latestFeedback.judge.state)}</span>
        ${
          latestFeedback.judge.confidenceLevel
            ? `<span class="muted-copy">置信等级：${escapeHtml(latestFeedback.judge.confidenceLevel)}</span>`
            : ""
        }
        ${latestFeedback.evidenceReference ? `<span class="muted-copy">依据：${escapeHtml(latestFeedback.evidenceReference)}</span>` : ""}
      </div>
      ${summaryBits.length ? summaryBits.map((item) => `<div>${escapeHtml(item)}</div>`).join("") : ""}
      ${
        latestFeedback.nextMove?.intent
          ? `<div><strong>系统下一步：</strong>${escapeHtml(latestFeedback.nextMove.intent)}</div>`
          : ""
      }
      ${
        latestFeedback.writebackSuggestion
          ? `<div class="muted-copy">记忆处理：${
              latestFeedback.writebackSuggestion.should_write
                ? escapeHtml(summarizeWritebackMode(latestFeedback.writebackSuggestion.mode))
                : "暂不写回长期记忆"
            }</div>`
          : ""
      }
      ${
        latestFeedback.memoryAnchor?.derivedPrinciple
          ? `<div class="muted-copy">当前长期记忆：${escapeHtml(latestFeedback.memoryAnchor.derivedPrinciple)}</div>`
          : ""
      }
      ${latestFeedback.turnResolution ? `<div class="muted-copy">流程决策：${escapeHtml(summarizeTurnResolution(latestFeedback.turnResolution))}</div>` : ""}
      ${
        latestFeedback.coachingStep
          ? `<div><strong>下一步：</strong>${escapeHtml(latestFeedback.coachingStep)}</div>`
          : ""
      }
    `;
  } else {
    elements.latestFeedback.classList.add("hidden");
    elements.latestFeedback.innerHTML = "";
  }
}

function renderTurnHistory(turns) {
  elements.turnHistory.innerHTML = turns
    .filter((turn) => !(turn.role === "system" && turn.kind === "workspace"))
    .map((turn) => {
      const meta = [turn.role === "tutor" ? "Tutor" : "你", turn.conceptTitle].filter(Boolean).join(" · ");
      const learningSources = (turn.learningSources || [])
        .map(
          (source) =>
            `<a class="guide-link" href="${encodeURI(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>`
        )
        .join("");
      const turnInsights = [];
      if (turn.runtimeMap?.anchor_assessment?.reasons?.length) {
        turnInsights.push(
          `<div><strong>判断：</strong>${escapeHtml(turn.runtimeMap.anchor_assessment.reasons.join("；"))}</div>`
        );
      }
      if (turn.nextMove?.intent) {
        turnInsights.push(`<div><strong>下一步动作：</strong>${escapeHtml(turn.nextMove.intent)}</div>`);
      }
      if (turn.writebackSuggestion) {
        turnInsights.push(
          `<div><strong>记忆写回：</strong>${
            turn.writebackSuggestion.should_write
              ? escapeHtml(summarizeWritebackMode(turn.writebackSuggestion.mode))
              : "暂不写回长期记忆"
          }</div>`
        );
      }
      if (turn.controlVerdict?.reason) {
        turnInsights.push(
          `<div><strong>控制层裁决：</strong>${escapeHtml(turn.controlVerdict.reason)}</div>`
        );
      }
      if (turn.turnResolution?.mode) {
        turnInsights.push(
          `<div><strong>最终流程：</strong>${escapeHtml(summarizeTurnResolution(turn.turnResolution))}</div>`
        );
      }
      return `<article class="turn-card ${turn.role}">
        <div class="turn-meta">${escapeHtml(meta)}</div>
        <div>${renderQuestionText(turn.content, turn.questionMeta)}</div>
        ${
          (turn.teachingParagraphs?.length || turn.teachingChunk)
            ? `<div class="turn-detail"><strong>学习讲解：</strong>${
                turn.teachingParagraphs?.length
                  ? turn.teachingParagraphs.map((block) => `<p>${escapeHtml(block)}</p>`).join("")
                  : renderMultilineText(turn.teachingChunk)
              }</div>`
            : ""
        }
        ${turn.coachingStep ? `<div class="turn-detail"><strong>下一步：</strong>${escapeHtml(turn.coachingStep)}</div>` : ""}
        ${turn.evidenceReference ? `<div class="turn-detail muted-copy">依据：${escapeHtml(turn.evidenceReference)}</div>` : ""}
        ${
          turnInsights.length
            ? `<details class="analysis-details"><summary>这一轮系统判断</summary>${turnInsights.join("")}</details>`
            : ""
        }
        ${learningSources ? `<div class="guide-link-row"><span class="muted-copy">推荐资料：</span>${learningSources}</div>` : ""}
      </article>`;
    })
    .join("");
}

function renderMasteryMap(masteryMap, selectedDomainId = "") {
  if (!masteryMap.length) {
    return;
  }

  const visibleItems = selectedDomainId
    ? masteryMap.filter((item) => item.domainId === selectedDomainId)
    : masteryMap;

  if (!visibleItems.length) {
    elements.masteryMap.innerHTML = "";
    elements.masteryEmpty.classList.remove("hidden");
    return;
  }

  elements.masteryEmpty.classList.add("hidden");
  elements.masteryMap.innerHTML = visibleItems
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

function renderAbilityDomains(domains, selectedDomainId = "") {
  elements.abilityDomains.innerHTML = domains
    .map(
      (domain) => `<button type="button" class="domain-card domain-button ${selectedDomainId === domain.id ? "active" : ""}" data-domain-id="${escapeHtml(domain.id)}">
        <h4>${escapeHtml(domain.title)}</h4>
        <ul>
          ${domain.items
            .map(
              (item) =>
                `<li><strong>${escapeHtml(item.title)}</strong> <span class="state-chip">${escapeHtml(item.state)}</span> <small>${escapeHtml(item.evidenceCount)} 条证据</small></li>`
            )
            .join("")}
        </ul>
      </button>`
    )
    .join("");
}

function renderNextSteps(nextSteps, selectedDomainId = "", concepts = []) {
  if (!nextSteps?.length) {
    elements.nextSteps.innerHTML = "";
    elements.nextStepsEmpty.classList.remove("hidden");
    return;
  }

  const visibleSteps = selectedDomainId
    ? nextSteps.filter((step) => step.domainId === selectedDomainId || step.abilityDomainId === selectedDomainId)
    : nextSteps;

  if (!visibleSteps.length) {
    const starterConcepts = selectedDomainId
      ? concepts.filter((concept) => (concept.abilityDomainId || concept.domainId) === selectedDomainId).slice(0, 3)
      : [];

    if (!starterConcepts.length) {
      elements.nextSteps.innerHTML = "";
      elements.nextStepsEmpty.classList.remove("hidden");
      return;
    }

    elements.nextStepsEmpty.classList.add("hidden");
    elements.nextSteps.innerHTML = starterConcepts
      .map((concept) => {
        const materials = (concept.remediationMaterials || [])
          .map(
            (material) =>
              `<div class="material-card"><strong>${escapeHtml(material.title)}</strong><br /><small>${escapeHtml(material.description)}</small></div>`
          )
          .join("");
        return `<li>
          <strong>${escapeHtml(concept.title)}</strong>
          <span class="state-chip">建议先读</span>
          <div>${escapeHtml(concept.remediationHint || "先读一轮资料，再进入这个能力域的测评。")}</div>
          ${materials ? `<div class="materials">${materials}</div>` : ""}
        </li>`;
      })
      .join("");
      return;
  }

  elements.nextStepsEmpty.classList.add("hidden");
  elements.nextSteps.innerHTML = visibleSteps
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

function renderRevisitQueue(revisitQueue, selectedDomainId = "", concepts = []) {
  const conceptDomainMap = Object.fromEntries(
    concepts.map((concept) => [concept.id, concept.abilityDomainId || concept.domainId || ""])
  );
  const pending = (revisitQueue || [])
    .filter((item) => !item.done)
    .filter((item) => !selectedDomainId || conceptDomainMap[item.conceptId] === selectedDomainId);
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

async function refreshProfile() {
  if (!state.user?.id) {
    return;
  }

  const profile = await fetchJson(`/api/profile/${state.user.id}`);
  state.user = profile.user;
  state.profile = profile;
  setMemoryProfileId(profile.user.memoryProfileId);
  renderAuthState();
}

async function login(handle, pin) {
  const payload = await postJson("/api/auth/login", {
    handle,
    pin
  });
  state.user = payload.profile.user;
  state.profile = payload.profile;
  setUserId(payload.profile.user.id);
  setMemoryProfileId(payload.profile.user.memoryProfileId);
  renderAuthState();
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

function scrollToElement(element) {
  if (!element) {
    return;
  }

  element.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setPage(page) {
  state.currentPage = page;
  if (state.session) {
    renderSession(state.session);
  } else {
    renderPageShell();
  }
}

elements.quickActionButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await submitAnswerWithIntent(
        button.dataset.answerIntent === "teach"
          ? "讲一下"
          : "下一题"
      );
    } catch (error) {
      window.alert(error.message);
    }
  });
});

elements.authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(elements.authForm);
  try {
    await login(formData.get("handle"), formData.get("pin"));
    elements.authForm.reset();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.refreshProfile?.addEventListener("click", async () => {
  try {
    await refreshProfile();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.signOut?.addEventListener("click", () => {
  clearUserState();
  renderAuthState();
  renderPageShell();
});

elements.startBaselineAssessment?.addEventListener("click", () => {
  state.selectedDomainId = "";
  state.selectedConceptId = "";
  setPage("assessment");
  scrollToElement(elements.probePanel);
});

elements.startDomainAssessment?.addEventListener("click", async () => {
  if (!state.session) {
    return;
  }

  try {
    const session = state.selectedConceptId
      ? await postJson("/api/session/focus-concept", {
          sessionId: state.session.sessionId,
          conceptId: state.selectedConceptId
        })
      : state.selectedDomainId
        ? await postJson("/api/session/focus-domain", {
            sessionId: state.session.sessionId,
            domainId: state.selectedDomainId
          })
        : state.session;
    renderSession(session);
    setPage("assessment");
    scrollToElement(elements.probePanel);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.readDomainMaterials?.addEventListener("click", () => {
  setPage("reading");
  scrollToElement(elements.materialsPanel);
});

elements.viewDomainMemory?.addEventListener("click", () => {
  setPage("memory");
  scrollToElement(elements.memoryPanel);
});

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page-nav]");
  if (pageButton) {
    setPage(pageButton.dataset.pageNav);
    return;
  }

  const conceptAction = event.target.closest("[data-concept-action]");
  if (conceptAction && state.session) {
    state.selectedConceptId = conceptAction.dataset.conceptId;
    state.selectedDomainId =
      (state.session.concepts || []).find((concept) => concept.id === state.selectedConceptId)?.abilityDomainId || "";
    if (conceptAction.dataset.conceptAction === "assess") {
      elements.startDomainAssessment?.click();
    } else {
      setPage("reading");
      renderSession(state.session);
      scrollToElement(elements.materialsPanel);
    }
    return;
  }

  const domainButton = event.target.closest("[data-domain-id]");
  if (!domainButton || !state.session) {
    return;
  }

  const nextDomainId = domainButton.dataset.domainId;
  state.selectedDomainId = state.selectedDomainId === nextDomainId ? "" : nextDomainId;
  state.selectedConceptId = "";
  if (!state.selectedDomainId) {
    state.currentPage = "overview";
    renderSession(state.session);
    return;
  }

  if (state.entryMode === "test-first") {
    elements.startDomainAssessment?.click();
    return;
  }

  state.currentPage = "reading";
  renderSession(state.session);
});

window.addEventListener("hashchange", async () => {
  if (hashSyncMuted) {
    return;
  }

  const route = parseWorkspaceHash(window.location.hash);
  applyRouteToState(route);

  if (route.sessionId && (!state.session || state.session.sessionId !== route.sessionId)) {
    try {
      const session = await fetchJson(`/api/session/${route.sessionId}`);
      renderSession(session);
      return;
    } catch {}
  }

  if (state.session) {
    renderSession(state.session);
  } else {
    renderPageShell();
  }
});

elements.targetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.user?.id) {
    window.alert("请先登录，再开始目标诊断。");
    return;
  }
  const formData = new FormData(elements.targetForm);
  state.entryMode = String(formData.get("entryMode") || "test-first");
  state.selectedDomainId = "";
  state.selectedConceptId = "";
  try {
    const session = await postJson("/api/session/start-target", {
      targetBaselineId: formData.get("targetBaselineId"),
      interactionPreference: formData.get("interactionPreference"),
      memoryProfileId: getMemoryProfileId(),
      userId: state.user.id
    });
    setMemoryProfileId(session.memoryProfileId);
    await refreshProfile();
    state.currentPage = "overview";
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
    await refreshProfile();
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
    applyRouteToState(parseWorkspaceHash(window.location.hash));
    const data = await fetchJson("/api/baselines");
    renderBaselines(data.baselines || []);
    updateTargetAccessState();

    const storedUserId = getUserId();
    if (storedUserId) {
      try {
        const profile = await fetchJson(`/api/profile/${storedUserId}`);
        state.user = profile.user;
        state.profile = profile;
        setMemoryProfileId(profile.user.memoryProfileId);
      } catch {
        clearUserState();
      }
    }
    renderAuthState();

    const route = parseWorkspaceHash(window.location.hash);
    if (route.sessionId) {
      try {
        const session = await fetchJson(`/api/session/${route.sessionId}`);
        renderSession(session);
        return;
      } catch {}
    }

    renderPageShell();
  } catch (error) {
    window.alert(error.message);
  }
}

bootstrap();
