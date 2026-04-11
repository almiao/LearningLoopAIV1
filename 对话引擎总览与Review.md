# 对话引擎总览与 Review

本文档用于整体 review 当前对话引擎，不讨论模型能力边界，只讨论：

- 上下文管理
- 系统提示词原文与参数来源
- 工程编排
- 工程侧处理与展示投影
- 当前结构性问题

本文主视角是当前生效的三层拆分架构：

- Frontend
- BFF
- AI Service

同时补充 legacy Node 链路作为对照。

---

## 1. 当前架构总览

### 1.1 当前主链

用户输入 -> `frontend` -> `bff` -> `ai-service` -> LLM Provider -> `ai-service` 编排 -> `bff` -> `frontend`

对应文件：

- 前端入口：[frontend/components/app-shell.js](/Users/lee/IdeaProjects/LearningLoopAIV1/frontend/components/app-shell.js)
- BFF 入口：[bff/src/server.js](/Users/lee/IdeaProjects/LearningLoopAIV1/bff/src/server.js)
- AI Service HTTP 入口：[ai-service/app/main.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/main.py)
- 会话编排：[ai-service/app/engine/session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)
- 上下文构造：[ai-service/app/engine/context_packet.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/context_packet.py)
- LLM 交互：[ai-service/app/engine/tutor_intelligence.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/tutor_intelligence.py)
- Envelope 规范化与校验：[ai-service/app/engine/turn_envelope.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/turn_envelope.py)
- 可见 transcript 投影：[src/view/chat-transcript.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/view/chat-transcript.js)
- visible session 聚合：[src/view/visible-session-view.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/view/visible-session-view.js)

### 1.2 Legacy 对照链

当前仓库仍保留 legacy Node 单体链路：

- [src/server.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/server.js)
- [src/tutor/session-orchestrator.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/session-orchestrator.js)
- [src/tutor/context-packet.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/context-packet.js)
- [src/tutor/tutor-intelligence.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/tutor-intelligence.js)
- [src/tutor/turn-envelope.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/turn-envelope.js)

这条链路现在主要承担：

- 行为对照
- 回归测试参考
- 迁移对照

---

## 2. 请求入口与外部契约

### 2.1 AI Service API

文件：[ai-service/app/main.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/main.py)

#### `POST /api/interview/start-target`

请求模型：

```python
class StartTargetRequest(BaseModel):
    userId: str = ""
    source: Dict[str, Any]
    decomposition: Dict[str, Any]
    targetBaseline: Dict[str, Any]
    memoryProfile: Dict[str, Any]
    interactionPreference: str = "balanced"
```

含义：

- `source`: 原始学习材料/题包
- `decomposition`: 已拆好的概念列表
- `targetBaseline`: 目标岗位/目标题包元数据
- `memoryProfile`: 长期记忆快照
- `interactionPreference`: 交互偏好

#### `POST /api/interview/answer`

请求模型：

```python
class AnswerRequest(BaseModel):
    sessionId: str
    answer: str
    intent: Optional[str] = None
    burdenSignal: str = "normal"
    interactionPreference: Optional[str] = None
```

含义：

- `answer`: 用户自由文本输入
- `intent`: 显式结构化动作
  - `teach`
  - `advance`
- `burdenSignal`:
  - `normal`
  - `high`

#### `POST /api/interview/focus-domain`

```python
class FocusDomainRequest(BaseModel):
    sessionId: str
    domainId: str
```

#### `POST /api/interview/focus-concept`

```python
class FocusConceptRequest(BaseModel):
    sessionId: str
    conceptId: str
```

### 2.2 BFF 职责

文件：[bff/src/server.js](/Users/lee/IdeaProjects/LearningLoopAIV1/bff/src/server.js)

当前职责：

- 用户登录/建号
- 读取与持久化 `memoryProfile`
- 根据 baseline pack 组装：
  - `source`
  - `decomposition`
  - `targetBaseline`
- 把请求代理到 AI Service
- 回传 `traceId`

### 2.3 Frontend 输入模型

文件：[frontend/components/app-shell.js](/Users/lee/IdeaProjects/LearningLoopAIV1/frontend/components/app-shell.js)

当前有两类输入：

#### A. 自由回答

- `answer = textarea.value`
- `intent = ""`

#### B. 显式按钮

- 点击“讲一下”：
  - `answer = "讲一下"`
  - `intent = "teach"`
- 点击“下一题”：
  - `answer = "下一题"`
  - `intent = "advance"`

也就是说：

- **按钮动作**走结构化意图
- **自然语言理解**仍由模型负责

---

## 3. 会话对象与上下文管理

### 3.1 Session 的核心字段

主文件：[ai-service/app/engine/session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)

当前关键字段如下：

| 字段 | 含义 | 责任层 |
| --- | --- | --- |
| `currentConceptId` | 当前正在讲的 concept | 编排层 |
| `currentProbe` | 当前等待用户回答的问题 | 编排层 |
| `currentQuestionMeta` | 当前问题元信息（来源/标签等） | 编排层 |
| `turns` | 全量 turn 日志 | 工程日志 / 展示输入 |
| `workspaceScope` | 当前活动范围（pack/domain/concept） | 编排层 |
| `engagement` | 用户交互计数器 | 交互上下文 |
| `runtimeMaps` | 每个 concept 的工作诊断态 | 模型工作记忆 |
| `memoryProfile` | 长期记忆快照 | 记忆层 |
| `revisitQueue` | 待回访 concept 队列 | 编排层 |
| `latestControlVerdict` | 最近一轮工程裁决 | 工程保护层 |
| `interactionLog` | 交互事件日志 | 观测层 |

### 3.2 `project_session()` 的对外投影

文件：[ai-service/app/engine/session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)

当前返回给前端/BFF 的主要字段包括：

- `sessionId`
- `concepts`
- `currentConceptId`
- `currentProbe`
- `currentQuestionMeta`
- `masteryMap`
- `nextSteps`
- `turns`
- `engagement`
- `workspaceScope`
- `currentRuntimeMap`
- `currentMemoryAnchor`
- `targetMatch`
- `abilityDomains`
- `memoryEvents`
- `latestMemoryEvents`
- `interactionLog`
- `latestFeedback`
- `memoryProfileSnapshot`

### 3.3 当前上下文管理的三层

文件：

- Python: [ai-service/app/engine/context_packet.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/context_packet.py)
- Legacy JS: [src/tutor/context-packet.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/context-packet.js)

当前上下文包分为三层：

#### A. `stable`

稳定层，描述当前轮不会剧烈变化的信息：

- `target`
- `scope`
- `anchorIdentity`
- `memoryAnchor`

#### B. `dynamic`

动态层，描述当前回合的输入与近场历史：

- `currentQuestion`
- `learnerAnswer`
- `burdenSignal`
- `interactionPreference`
- `engagement`
- `previousRuntimeMap`
- `recentTurns`
- `anchorHistory`
- `recentEvidence`
- `rawEvidencePoint`

#### C. `reference`

参考层，描述外部知识与资料来源：

- `sources`
- `sourceSummary`

### 3.4 平铺 alias

为了便于 prompt 直接消费，当前还会额外平铺出：

- `target`
- `scope`
- `anchor`
- `memory_anchor_summary`
- `recent_evidence`
- `recent_turns`
- `anchor_history`
- `source_refs`
- `runtime_understanding_map`
- `budget`
- `friction_signals`
- `stop_conditions`
- `draft_evidence`

### 3.5 `anchor_history` 现状

这是当前为了支持“增量辅导”而新增的关键上下文字段。

#### Python 形态

```json
{
  "recent_turns": [
    {
      "role": "tutor|learner",
      "kind": "question|feedback|answer|control",
      "action": "teach|check|advance|...",
      "content": "...",
      "takeaway": "..."
    }
  ],
  "teach_count": 1,
  "has_recent_teaching": true,
  "recent_takeaways": ["...", "..."]
}
```

#### 当前作用

- 告诉模型：这题最近是否已经被讲过
- 告诉模型：最近收口结论是什么
- 给模型做“补缺口而不是整段重讲”提供材料

#### 当前不足

- 仍偏“原始历史”
- 没有明确摘要：
  - `last_full_explanation_summary`
  - `current_missing_link`
  - `confirmed_understanding`

### 3.6 `interaction_context` 的现状

当前没有被正式命名成独立对象，但实际上它分散存在于：

- `intent`
- `engagement`
- `friction_signals`
- `stop_conditions`
- `workspaceScope`

也就是说：

- **交互上下文实际上已经存在**
- 但还没有被收敛成一个单独的 contract 名称和对象边界

---

## 4. 系统提示词原文与参数来源

这里整理的是**当前 split-service 主链实际使用的提示词**。

### 4.1 公共 system prompt

来源：

- 文件：[ai-service/app/engine/tutor_intelligence.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/tutor_intelligence.py)
- 方法：`ProviderTutorIntelligence._call_json_traced()`

原文：

```text
You are the cognition layer for an AI tutor. Return valid json only. Use the submitted material as the primary anchor, but you may use necessary background knowledge to teach clearly. Never drift into generic motivational talk.
```

适用的调用类型：

- `decompose`
- `answer_turn`
- `explain_concept`

公共参数：

- `call_type`
- `provider`
- `model`
- `parser_version`
- `schema`
- `validator`

---

### 4.2 Prompt A：`decompose_source`

来源：

- 文件：[ai-service/app/engine/tutor_intelligence.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/tutor_intelligence.py)
- 方法：`ProviderTutorIntelligence.decompose_source()`

原文模板：

```text
Read the submitted learning material and produce 3-7 document-local teachable units.
Requirements:
- Stay anchored to the submitted source, but use minimal background knowledge when needed for clearer teaching.
- Do not leak frontmatter, tags, SEO metadata, or boilerplate into the learner-facing summary.
- Each unit must support a concrete first diagnostic question.
- Each unit should include a check question for teach-back after explanation.
- Prefer mechanisms, distinctions, failure modes, and misconceptions over broad topic labels.
- Assign importance as core/secondary/optional and coverage as high/medium/low.

TITLE: {SOURCE_TITLE}
URL: {SOURCE_URL?}
CONTENT:
{SOURCE_CONTENT}
```

参数来源：

- `{SOURCE_TITLE}`: `source.title`
- `{SOURCE_URL}`: `source.url`
- `{SOURCE_CONTENT}`: `source.content`

输出 schema：

- `DECOMPOSITION_SCHEMA`

用途：

- 把 source 拆成 `concepts[]`
- 为后续对话提供：
  - `summary`
  - `excerpt`
  - `keywords`
  - `diagnosticQuestion`
  - `retryQuestion`
  - `checkQuestion`

---

### 4.3 Prompt B：`answer_turn` 主回合推理 prompt

来源：

- 文件：[ai-service/app/engine/tutor_intelligence.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/tutor_intelligence.py)
- 方法：`build_turn_envelope_prompt()`

原文模板：

```text
You are the main reasoning engine for one AI tutor turn. Return json only.
Use Chinese in all visible learner-facing text.
Follow this internal order: first update runtime_map, then decide next_move, then write the reply, then propose writeback_suggestion.
Preserve prior hypotheses unless new evidence explicitly refutes them.
The runtime_map must stay anchored to the current anchor_id and cite evidence ids where possible.
Do not ask repetitive probes when info_gain_level is negligible or stop_conditions discourage more probing.
Budget, friction_signals, and stop_conditions are orchestration factors. Consider them before proposing continued probing or verification.
The reply must sound like a strong human tutor, not like a template or checklist.
Interpret the learner utterance pragmatically: it may contain an answer, a request for explanation, a request to move on, or a mix of these.
When the learner utterance is mainly asking for explanation or summary rather than offering substantive evidence, prefer a closure-oriented helpful reply instead of a bare acknowledgement plus another question.
Prefer incremental tutoring over repetition. If recent turns on the same anchor already explained the core mechanism, do not restate the whole explanation unless the learner is still clearly lost; instead name the one missing link, add at most one new example, and move to a narrower follow-up.
Avoid repeatedly opening with stock transitions such as '进入学习模式' or similar phrases if recent turns already used them.
Use anchor_history to understand what has already been taught on the current anchor; if it contains recent tutor explanations, treat them as prior teaching context rather than repeating them verbatim.
When teach is the right move, teaching_paragraphs must contain a complete explanation; do not use rigid headings such as 核心结论 or 理解抓手.
When you choose verify, the visible reply should still add concrete value before any follow-up question.
When a response is still needed on the current anchor, next_prompt must be a concrete question the learner can answer immediately.
Treat next_prompt as a candidate follow-up only for staying on the current anchor. If the turn should hand off to a different anchor or stop, leave next_prompt empty.
When long-term memory should not be updated, set writeback_suggestion.should_write to false and mode to noop.

CONTEXT_PACKET_JSON:
{CONTEXT_PACKET_JSON}

CURRENT_LEARNER_INPUT: {ANSWER}
```

参数来源：

- `{CONTEXT_PACKET_JSON}`: `build_context_packet(...)`
- `{ANSWER}`: 当前回合 `payload.answer`

输出 schema：

- `TURN_ENVELOPE_SCHEMA`

输出结构四段：

- `runtime_map`
- `next_move`
- `reply`
- `writeback_suggestion`

---

### 4.4 Prompt C：`explain_concept`

来源：

- 文件：[ai-service/app/engine/tutor_intelligence.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/tutor_intelligence.py)
- 方法：`ProviderTutorIntelligence.explain_concept()`

原文模板：

```text
You are generating a compact study card for a tutoring product. Return json only.
The learner explicitly clicked a control meaning 'teach me this point now'.
Use Chinese in all visible text.
Ground the explanation in the concept and the provided JavaGuide snippets.
Do not produce generic motivation. Produce a concise but genuinely useful learning card that can stand on its own even if the learner never opens the source articles.

TARGET: {TARGET_TITLE}
CURRENT CONCEPT: {CONCEPT_TITLE}
CONCEPT SUMMARY: {CONCEPT_SUMMARY}
CONCEPT EXCERPT: {CONCEPT_EXCERPT}
MISCONCEPTION: {MISCONCEPTION}
REMEDIATION HINT: {REMEDIATION_HINT}
CHECK QUESTION: {CHECK_QUESTION}
CURRENT QUESTION: {CURRENT_QUESTION}
CONTEXT_PACKET: {CONTEXT_PACKET_JSON}
GUIDE_SNIPPETS_JSON:
{GUIDE_SNIPPETS_JSON}

Requirements:
- visibleReply should sound like a tutor switching into study mode
- teachingParagraphs must be a complete teaching explanation, not a note stub
- teachingParagraphs should feel like a short live explanation from a strong tutor, not like a checklist
- if the learner has already seen a full explanation for this anchor in recent turns, compress to the missing link instead of repeating the whole lecture
- cover the concept definition, mechanism, boundary/contrast, and the most common misunderstanding, but do it naturally rather than through forced section headers
- use the JavaGuide snippets as supporting references only; do not let the output degrade into a list of article titles
- never use rigid labels such as '核心结论' or '理解抓手' or '建议阅读' as section headers
- return 2-4 short natural paragraphs in teachingParagraphs
- checkQuestion should force a teach-back in the learner's own words
- takeaway should be a single stable sentence
```

参数来源：

- `{TARGET_TITLE}`: `session.targetBaseline.title` 或 `session.source.title`
- `{CONCEPT_TITLE}`: `concept.title`
- `{CONCEPT_SUMMARY}`: `concept.summary`
- `{CONCEPT_EXCERPT}`: `concept.excerpt`
- `{MISCONCEPTION}`: `concept.misconception`
- `{REMEDIATION_HINT}`: `concept.remediationHint`
- `{CHECK_QUESTION}`: `concept.checkQuestion || concept.retryQuestion`
- `{CURRENT_QUESTION}`: `session.currentProbe`
- `{CONTEXT_PACKET_JSON}`: 当前锚点 context packet
- `{GUIDE_SNIPPETS_JSON}`: `load_java_guide_source_snippets(...)`

输出 schema：

- `EXPLAIN_CONCEPT_SCHEMA`

---

## 5. 工程编排流程

### 5.1 `start-target` 流程

入口：

- BFF: [bff/src/server.js](/Users/lee/IdeaProjects/LearningLoopAIV1/bff/src/server.js)
- AI Service: [ai-service/app/main.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/main.py)
- 编排：`create_session()` in [session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)

流程：

1. BFF 读取用户与 `memoryProfile`
2. BFF 组装 `source / decomposition / targetBaseline`
3. AI Service 初始化 session：
   - `concepts`
   - `conceptStates`
   - `ledger`
   - `runtimeMaps`
   - `workspaceScope`
   - `turns`
4. 生成第一题 `currentProbe`
5. 返回 `project_session()`

### 5.2 `answer` 主流程

入口：

- [ai-service/app/main.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/main.py)
- [ai-service/app/engine/session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)

当前流程：

1. 取当前 `concept`
2. 识别控制意图
   - `detect_control_intent(answer, intent)`
3. 写入 learner turn
4. 若是控制动作：
   - `teach` -> `handle_teach_control()`
   - `advance` -> `handle_advance_control()`
5. 若是普通回答：
   - 构建 `context_packet`
   - 调用 `generate_turn_envelope`
   - normalize
   - validate
   - consistency check
   - envelope -> tutorMove
6. 工程侧更新：
   - `ledger`
   - `runtimeMaps`
   - `conceptStates`
   - `memoryProfile`
7. 计算：
   - `controlVerdict`
   - `turnResolution`
   - `latestFeedback`
8. 选择下一题：
   - `choose_next_unit()`
9. 追加 tutor feedback turn
10. 如有 `currentProbe`，再追加 tutor question turn
11. `project_session()`

### 5.3 `focus-domain` / `focus-concept`

入口：

- [ai-service/app/main.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/main.py)
- [ai-service/app/engine/session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)

流程：

1. 更新 `workspaceScope`
2. 选定焦点 concept
3. 写入 workspace turn
4. 写入新的 tutor question turn
5. 返回投影后的 session

---

## 6. 工程侧处理

### 6.1 控制意图处理

文件：[ai-service/app/engine/control_intents.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/control_intents.py)

当前策略：

- 优先吃结构化 `intent`
- 自然语言仅做兼容：
  - `讲一下`
  - `下一题`

这是**输入入口层**，不是 tutor 内容策略层。

### 6.2 Provider 输出处理

文件：

- [ai-service/app/domain/interview/parsers.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/domain/interview/parsers.py)
- [ai-service/app/engine/tutor_intelligence.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/tutor_intelligence.py)

主要处理：

1. 原始 JSON 提取
   - 去 code fence
   - 从文本中截 JSON
2. alias normalize
   - `部分掌握 -> partial`
   - `正向 -> positive`
3. payload normalize
   - `normalize_turn_envelope_payload()`
   - `normalize_explain_concept_payload()`

### 6.3 Envelope 规范化与校验

文件：[ai-service/app/engine/turn_envelope.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/turn_envelope.py)

三步：

1. `assert_valid_turn_envelope()`
   - schema / 枚举 / 必填校验
2. `assert_consistent_turn_envelope()`
   - 工程一致性校验
   - 例如：
     - `teach` 必须带 `teaching_paragraphs`
     - `advance/stop` 不能还要求用户回答
3. `turn_envelope_to_tutor_move()`
   - LLM 输出 contract -> 内部 tutor move

### 6.4 `runtime_map` / `next_move` / `writeback_suggestion`

当前语义：

- `runtime_map`
  - 当前 concept 的工作诊断态
- `next_move`
  - 模型建议的下一步动作
- `writeback_suggestion`
  - 是否写入长期记忆以及写入什么

这里要注意：

- 这是**模型输出 contract**
- 工程侧会校验和使用
- 但当前仍存在“模型在一个 prompt 里承担职责较多”的问题

### 6.5 `controlVerdict`

文件：[ai-service/app/engine/turn_envelope.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/turn_envelope.py)

输入：

- `next_move`
- `reply.requires_response`
- `runtime_map`
- `stop_conditions`
- `budget`

输出：

- `should_stop`
- `reason`
- `scope_type`
- `budget_snapshot`

它的定位是：

- **工程保护层**
- 对“模型建议继续追问”做二次裁决

### 6.6 记忆写回

文件：[ai-service/app/engine/session_engine.py](/Users/lee/IdeaProjects/LearningLoopAIV1/ai-service/app/engine/session_engine.py)

当前写回对象：

- `memoryProfile.abilityItems[conceptId]`

写回内容：

- `state`
- `confidence`
- `reasons`
- `derivedPrinciple`
- `evidence`
- `recentStrongEvidence`
- `recentConflictingEvidence`

---

## 7. 展示层与投影

### 7.1 `visible-session-view`

文件：[src/view/visible-session-view.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/view/visible-session-view.js)

作用：

- 从 session 中聚合：
  - `chatTimeline`
  - `currentProbe`
  - `latestFeedback`
  - `targetMatch`
  - `latestMemoryEvents`
  - `interactionLog`

### 7.2 `chat-transcript`

文件：[src/view/chat-transcript.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/view/chat-transcript.js)

职责：

- 工程 `turns[]` -> 用户可见 transcript entries

当前规则：

- workspace turn -> event
- learner turn -> user message
- tutor feedback + same-concept tutor question -> 合并
- tutor feedback + cross-concept tutor question -> 不合并
- 条件展示：
  - `bodyParts`
  - `takeaway`
  - `followUpQuestion`
  - `candidateFollowUpQuestion`
  - `coachingStep`

### 7.3 `带走一句`

当前不是“只要有 takeaway 就显示”。

显示条件：

- `teach`
- `advance`
- `abstain`
- 或没有后续追问的 turn

因此它现在更接近：

- 回合收口总结

而不是：

- 每轮固定标签

---

## 8. 当前最值得 review 的结构性问题

### 8.1 当前上下文对象仍然偏多、边界有重叠

目前涉及“当前题/下一步/裁决”的对象有：

- `currentConceptId`
- `currentProbe`
- `runtimeMap`
- `nextMove`
- `turnResolution`
- `controlVerdict`
- `anchor_history`
- `intent`
- `engagement`
- `friction_signals`
- `stop_conditions`
- `workspaceScope`

问题不在“没有”，而在：

- 真相分散
- 概念重叠
- review 不直观

### 8.2 `interaction_context` 还不是正式对象

用户输入相关上下文目前分散在：

- `intent`
- `engagement`
- `friction_signals`
- `stop_conditions`
- `workspaceScope`

建议后续 review 是否要正式收敛成：

- `interaction_context`

### 8.3 `anchor_history` 已存在，但摘要还不够强

现在它能告诉模型：

- 最近几轮同题说了什么
- 是否最近 teach 过
- 最近 takeaway 是什么

但还不能直接告诉模型：

- 这题上一次完整讲解的摘要是什么
- 当前唯一缺口是什么
- 已确认理解的部分是什么

### 8.4 一个 turn prompt 里承担的责任仍然偏多

当前 `answer_turn` 一次要完成：

- 诊断当前理解
- 选择下一步
- 生成回复
- 生成 follow-up
- 决定写回建议

这是当前结构上最值得继续 review 的点之一。

### 8.5 split-service 与 legacy Node 仍有漂移风险

现状：

- split-service 是主链
- legacy Node 仍保留较多 fallback surface

这会带来：

- 行为定义来源不唯一
- 迁移后续继续漂移的风险

---

## 9. 建议 review 顺序

建议整体 review 时按这个顺序看：

1. 当前上下文 contract 是否足够清晰
2. 是否要抽出正式的 `interaction_context`
3. `anchor_history` 要不要继续升级为摘要对象
4. `answer_turn` 是否应继续承担这么多职责
5. `writeback_suggestion` 是否还应该继续放在同一主 prompt 里
6. `takeaway / follow-up / candidateFollowUp` 的展示策略是否已经足够轻量

---

## 10. Legacy 对照说明

Legacy Node 中仍保留：

- `reviewTurn`
- `generateTutorTurn`
- heuristic intelligence

对应文件：

- [src/tutor/tutor-intelligence.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/tutor-intelligence.js)
- [src/tutor/session-orchestrator.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/session-orchestrator.js)
- [src/tutor/context-packet.js](/Users/lee/IdeaProjects/LearningLoopAIV1/src/tutor/context-packet.js)

建议后续在设计讨论里：

- 以 split-service 为当前标准链路
- 以 legacy 为行为对照与迁移参考

