# LoopAssist Content Selection V1

Status: Proposed
Date: 2026-05-20
Owner: Codex + product discussion

## Summary

LoopAssist V1 should let users choose what they want to be examined on, then enter a voice-first interview session generated from real interview reports plus LLM reasoning.

The source of truth for V1 is the interview-report corpus from `newcode-craw`. The LLM acts as the interviewer: it turns report-derived question seeds into natural questions, asks follow-ups, evaluates answers, and explains what a stronger answer would include.

The valuable product move is not "AI randomly asks questions". The move is giving the learner control over the examination scope, then making the interview feel like it came from real company interviews.

Difficulty is medium, not extreme. The hard part is not generating questions. The hard part is keeping the setup simple, selecting good real questions, and making the follow-up feel like an interviewer rather than a flashcard engine.

## Product Judgment

This is worth doing.

LearningLoop already has reading, training, memory, and document progress. The current system can train from one document or a baseline pack, but it does not yet let users say: "I want a realistic interview on this role, this round, and these topics."

That is the missing bridge between passive learning and interview readiness.

## User Promise

The user can choose a target scope like:

- "Java 后端一面 高频八股"
- "AI Infra 一面 Transformer/RAG"
- "前端二面 项目追问"
- "测试开发 场景题 + 自动化测试"

LoopAssist then runs a live interview loop:

1. Ask one grounded question.
2. Listen to the user's answer.
3. Evaluate the answer against the question intent and common strong-answer signals.
4. Ask a follow-up if the answer is shallow.
5. Explain what the interviewer would likely follow up on.

## Non-Goals

V1 should not attempt:

1. User-document grounding.
2. Open-source project ingestion.
3. Perfect company-specific simulation.
4. Automatic resume screening or hiring recommendation.
5. External web retrieval.

The ideal interaction is voice-only for participation. Text remains as a simple chat transcript in the side panel; if microphone setup fails, the room should ask the user to fix or retry voice instead of switching to typed answers.

## Current Leverage

The repo already has most of the runtime pieces:

1. `POST /api/interview/start-target`
   Existing session start boundary.

2. `handleStartTarget` in `bff/src/server.js`
   Already supports either a baseline pack or a document-backed training source.

3. Existing session projection and profile state
   Already provide the interview loop, user memory, and answer evaluation surface.

4. `baseline-packs`
   Already models domains, concepts, provenance, diagnostic questions, and follow-up structure. LoopAssist can reuse the shape without depending on Java-specific content.

5. `newcode-craw`
   Already provides real interview reports with title, content, job context, metrics, URL, publish time, and source list URL.

   Already has realtime session, ASR transcript, voice demo, LiveKit transport, and answer streaming surfaces that LoopAssist can reuse.

The system does not need a fresh tutor engine. It needs a new "assessment scope" layer before session creation, plus a question-seed corpus generated from real reports.

## Proposed UX

### Entry Point

Add a LoopAssist entry from the home page and interview assist surface:

- Home: "选择考察内容"
- Interview corpus page: "从真实面经开始练"

### Selection Screen

The screen should feel like setting up an interview, not configuring a search query.

Primary controls:

1. Target role
   Examples: Java 后端, 前端, 测开, AI Infra, 算法, 运维.

2. Interview stage
   Examples: 一面, 二面, 三面, HR, 项目深挖, 八股, 算法手撕.

3. Topic focus
   Examples:
   - 项目深挖
   - 八股基础
   - 算法手撕
   - 场景设计
   - HR / 行为面

4. Company style
   Examples:
   - 不限公司
   - 阿里系
   - 字节系
   - 美团/腾讯/百度
   - AI Infra 公司

5. Difficulty and style
   Examples: 基础确认, 深挖追问, 压力面, 讲解型.

The primary CTA:

`开始 LoopAssist 面试`

### Session Screen

The session screen should be voice-first:

1. Main stage: live interviewer voice, listening state, and current spoken prompt.
2. Side panel: chat transcript only.
3. Bottom bar: microphone, skip, pause, and finish controls.
4. Review drawer: available only after the interview ends.

## Interaction Design

### Screen 1: LoopAssist Setup

Purpose:

Let the user create a realistic interview in under one minute.

Layout:

1. Left rail: interview scope.
2. Main panel: topic and style selection.
3. Right panel: live preview of the generated interview plan.

Recommended first-screen sections:

1. `岗位`
   Use large segmented options for common roles: 后端, 前端, 测开, 算法, AI Infra, 数据, 运维.

2. `轮次`
   Use compact chips: 一面, 二面, 三面, HR, 项目面, 综合面.

3. `考察重点`
   Use selectable topic chips with counts from the corpus. Example: 项目, 八股, 手撕, 场景, MySQL, Redis, 网络, 操作系统, Agent, RAG, Transformer.

4. `面试风格`
   Use a segmented control:
   - 友好练习
   - 标准面试
   - 深挖追问
   - 压力面

5. `题量`
   Use a small stepper: 5, 8, 10.

Right preview panel:

1. Matched report count.
2. Topic coverage bars.
3. Three sample question seeds.
4. Warning area for thin scopes, such as "AI Infra + HR 面目前样本较少".

Primary CTA:

`开始模拟面试`

Secondary actions:

1. `换一组样题`
2. `保存这个考察范围`

### Screen 2: Interview Room

Purpose:

Make it feel like an interview, not a quiz page.

Layout:

1. Top: compact room context.
   Example: `AI Infra · 一面 · 标准面试`. Keep it small enough that the voice stage remains dominant.

2. Center: voice stage.
   Show interviewer speaking/listening state, elapsed time, and a compact current prompt. The user's primary response path is microphone input.

3. Right side panel: chat transcript.
   Show only the interview conversation: interviewer turns and candidate turns. Avoid source badges, scope summaries, answer hints, and diagnostic panels during the interview.

4. Bottom controls.
   Microphone toggle, skip, pause, and finish.

After user answers:

1. Speak and stream the next interviewer question.
2. Append the interviewer/candidate turn to the chat transcript.
3. Keep source context out of the interview room.
4. Do not show per-answer verdicts or missing-signal analysis during the interview.

The main conversation should keep moving. Per-answer teaching would break the interview illusion; save evaluation for the final review.

Controls:

1. `麦克风`
2. `跳过这题`
3. `暂停`
4. `结束并复盘`

The microphone is primary. Typed input can appear only as a fallback mode for noisy rooms, privacy, or microphone failure.

### Screen 3: Review

Purpose:

Turn the session into an actionable post-interview review.

Sections:

1. Overall readiness score.
2. Strongest topics.
3. Weakest topics.
4. Questions that would likely trigger follow-up.
5. "Replay this scope" CTA.
6. "Make next round harder" CTA.

The review should not pretend to be a hiring decision. It should say what the user needs to tighten before the next interview.

## Source Types

### 1. Real Interview Reports

Raw input:

`/Users/lee/IdeaProjects/newcode-craw/data/nowcoder_interviews.jsonl`

Normalize each useful report into:

```json
{
  "id": "nowcoder:2846317",
  "provider": "nowcoder",
  "title": "沐曦 AI Infra 27实习一面分享",
  "rolePath": ["软件开发", "人工智能/算法"],
  "stage": "一面",
  "company": "沐曦",
  "topics": ["AI Infra", "C++", "CUDA", "Transformer", "哈希"],
  "questions": [],
  "contentText": "",
  "sourceUrl": "https://www.nowcoder.com/feed/main/detail/...",
  "publishedAt": "2026-...",
  "metrics": {
    "viewCount": 73,
    "likeCount": 0,
    "commentCount": 0
  }
}
```

Then extract question seeds:

```json
{
  "id": "seed:nowcoder:2846317:cuda-parallelism",
  "sourceId": "nowcoder:2846317",
  "question": "CUDA 编程中并行性与并发性的区别是什么？",
  "topic": "CUDA",
  "questionType": "concept_explain",
  "stage": "一面",
  "difficulty": "medium",
  "evidenceSnippet": "CUDA 编程中并行性与并发性的区别",
  "reviewSourceRefs": []
}
```

### 2. LLM Interviewer Knowledge

V1 uses the LLM's general technical knowledge to evaluate answers and ask follow-ups. It should not pretend that this knowledge came from a local document.

The product should be explicit about this boundary:

1. Real interview reports determine what gets asked.
2. The LLM determines how to probe, evaluate, and explain.
3. Source badges refer to report-derived question seeds, not external references.

### Future Source Types

These should remain future additions until the real-report loop feels good:

1. External retrieval.
   Use web/search retrieval to fetch fresh context for fast-moving topics, company-specific stacks, and unfamiliar tools.

2. User documents.
   Let users upload resumes, project notes, or architecture docs so LoopAssist can personalize project follow-up.

3. Open-source projects.
   Start with curated README/docs ingestion before attempting full repository understanding.

## Core Data Model

### AssessmentScope

This is the main new concept.

```json
{
  "id": "scope:user-123:20260520",
  "userId": "user-123",
  "targetRole": "Java 后端工程师",
  "stage": "二面",
  "mode": "deep_followup",
  "difficulty": "medium",
  "sourceMix": {
    "interviewReports": true,
    "llmInterviewer": true,
    "externalRetrieval": false,
    "userDocuments": false
  },
  "selectedSources": [],
  "topicFilters": ["Redis", "并发", "项目深挖"],
  "questionBudget": 8
}
```

### QuestionSeed

Question seeds are not final questions. They are grounded prompts the AI can adapt.

```json
{
  "id": "seed-id",
  "sourceType": "interview-report",
  "sourceRef": {},
  "topic": "Redis",
  "baseQuestion": "Redis 持久化机制有哪些？",
  "expectedSignals": [
    "能区分 RDB 和 AOF",
    "能说明恢复速度和数据丢失窗口",
    "能结合业务场景取舍"
  ],
  "followupAngles": [
    "线上丢数据怎么办",
    "AOF rewrite 的风险",
    "大 key 对持久化的影响"
  ],
  "strongAnswerSignals": [],
  "sourceReportUrl": ""
}
```

### AssessmentSession

Existing interview sessions can remain the runtime shape. Add only lightweight scope metadata and transcript history:

```json
{
  "sessionId": "session-123",
  "scopeId": "scope:user-123:20260520",
  "sourceMode": "loopassist",
  "selectedSourceRefs": [],
  "questionBudget": 8,
  "turns": []
}
```

## Real Interview Loop

LoopAssist must simulate a continuing interview, not a static question set.

The AI interviewer should decide the next question in real time from the full transcript, selected scope, interview style, and available question seeds. The product should not model that as an exposed state machine. The user should simply experience a human-like interviewer who listens, speaks, and continues.

The user should experience this as a natural conversation:

```text
Interviewer: Redis 的 RDB 和 AOF 有什么区别？线上怎么取舍？
User: RDB 是快照，AOF 是日志，AOF 更安全。
Interviewer: 你说 AOF 更安全。那 AOF rewrite 期间如果机器宕机会发生什么？你怎么解释风险边界？
User: ...
Interviewer: 好，换一个方向。Redis 大 key 会怎么影响持久化和主从同步？
```

### Runtime Contract

Every AI turn should be simple:

```json
{
  "role": "interviewer",
  "text": "AOF rewrite 期间如果机器宕机会发生什么？"
}
```

The frontend renders the interviewer text in the chat transcript and voice stage. It does not render per-turn scores, hidden evaluations, machine-readable decisions, source badges, or setup metadata during the interview.

## Voice-First Experience

The ideal LoopAssist session is spoken.

Primary path:

1. AI interviewer speaks the question.
2. User answers by voice.
3. ASR writes partial and final transcript into the chat side panel.
4. AI interviewer reads the transcript plus conversation history and speaks the next question.
5. The side panel quietly accumulates the conversation for final review.

The main stage should feel like being in a call:

1. Large listening/speaking indicator.
2. Compact current prompt.
3. Mic health and permission state.
4. Time elapsed and soft progress.
5. Minimal controls.

The text side panel should contain only the chat:

1. Live candidate transcript while speaking.
2. Finalized interviewer turns.
3. Finalized candidate turns.

Text should support the voice experience, not become a dashboard. The user should be able to close or narrow the side panel and still continue the interview by voice.

### Prompt-Controlled Behavior

Pacing, follow-up depth, topic switching, clarification, and pressure should live in the prompt. This keeps the runtime simple and lets the LLM behave more naturally.

The interviewer prompt should include:

1. Keep the conversation moving like a real interview.
2. Ask one question at a time.
3. Follow up naturally when the answer is shallow, vague, or exposes an interesting gap.
4. Move to a new topic when the current topic has enough signal.
5. Do not reveal the ideal answer during the interview.
6. Do not output scores, labels, or analysis until the final review.
7. Respect the selected style and question budget.

### Interviewer Styles

The style selector should change behavior, not only copy:

1. `friendly_practice`
   More clarifying prompts, softer scoring, more explanation after answers.

2. `standard_interview`
   Balanced follow-ups, concise feedback, realistic pacing.

3. `deep_followup`
   More "why", "how would this fail", "what if traffic grows" questions.

4. `pressure_interview`
   Shorter prompts, fewer hints, stricter scoring, more scenario pivots.

### Session Ending

End the interview when the user clicks `结束并复盘` or when the AI decides the selected budget has enough signal. The UI can show a soft progress indicator, but it should not force a rigid topic state.

The final review should be generated from the full transcript and selected scope. This is where scores, strengths, weaknesses, and likely follow-up risks belong.

## API Design

### `GET /api/loopassist/options`

Returns selectable roles, stages, topic clusters, and source counts.

Query:

```text
userId=user-123
```

Response:

```json
{
  "roles": [],
  "stages": [],
  "topicClusters": [],
  "sourceCounts": {
    "interviewReports": 3197,
    "questionSeeds": 0
  }
}
```

### `POST /api/loopassist/preview-scope`

Returns the likely question mix before starting.

Request:

```json
{
  "userId": "user-123",
  "targetRole": "AI Infra",
  "stage": "一面",
  "topicFilters": ["Transformer", "CUDA"],
  "selectedSources": []
}
```

Response:

```json
{
  "estimatedQuestionCount": 42,
  "sampleQuestions": [],
  "coverage": [
    { "topic": "Transformer", "count": 12 },
    { "topic": "CUDA", "count": 4 }
  ],
  "warnings": []
}
```

### `POST /api/loopassist/start`

Creates an assessment scope and starts an interview session.

Internally, BFF can translate this into the existing `/api/interview/start-target` payload with a richer `source` and `decomposition`.

Request:

```json
{
  "userId": "user-123",
  "scope": {},
  "interactionPreference": "balanced"
}
```

Response:

Same as `/api/interview/start-target`, plus:

```json
{
  "scopeId": "scope-id",
  "sourceMode": "loopassist"
}
```

### `POST /api/loopassist/answer`

Submits one finalized user answer and returns the next interviewer message. This is the text fallback path and the non-realtime baseline.

V1 can route this through the existing `/api/interview/answer` or `/api/interview/answer-stream` internals, but the LoopAssist contract should keep the runtime output simple.

Request:

```json
{
  "sessionId": "session-123",
  "answer": "RDB 是快照，AOF 是追加日志...",
  "userControl": "",
  "interactionPreference": "balanced"
}
```

Response:

```json
{
  "sessionId": "session-123",
  "interviewerTurn": {
    "text": "你说 AOF 更安全。那 AOF rewrite 期间如果机器宕机会发生什么？"
  },
  "progress": {
    "questionIndex": 1,
    "questionBudget": 8,
    "turnsUsed": 2
  }
}
```

### `POST /api/loopassist/answer-stream`

Streaming variant for the text fallback path.

Recommended events:

1. `thinking`
   Short progress status while the interviewer prepares the next question.

2. `turn_append`
   Append the next interviewer message.

3. `session`
   Final projected session state.

4. `review`
   Final review payload when the session ends.

### Realtime Voice Transport

LoopAssist should own its own optional voice stack after the realtime assist extraction.

Target capabilities:

1. Start a realtime LoopAssist session after scope selection.
2. Stream microphone audio to ASR.
3. Receive `transcript_partial` and `transcript_final`.
4. Send finalized candidate turns to the LoopAssist interviewer prompt.
5. Speak or stream the next interviewer turn.
6. Persist the transcript for final review.

The existing surfaces to study first:

LoopAssist no longer depends on the extracted realtime assist transport.

## AI Flow

### Step 1: Build Scope Packet

BFF assembles:

1. Selected question seeds.
2. Source snippets.
3. Strong-answer signals inferred during import.
4. User memory profile.
5. Full LoopAssist transcript so far.

### Step 2: Generate Next Interviewer Message

The AI should receive a constraint like:

```text
You are simulating a real interview.
Read the full transcript.
Ask exactly one next interviewer question.
You may follow up, clarify, or move to a new topic based on the user's last answer.
Use the selected scope and question seeds as background, not as a rigid script.
Do not reveal the expected answer before the user answers.
Do not output scores, labels, or analysis during the interview.
```

The output should be interviewer-facing text plus minimal metadata:

```json
{
  "text": "你说 AOF 更安全。那 AOF rewrite 期间如果机器宕机会发生什么？"
}
```

### Step 3: Generate Final Review

When the user ends the session, generate the final review from the full transcript:

1. Readiness score.
2. Topic-by-topic performance.
3. Strong answers.
4. Weak answers.
5. Most likely real-interview follow-ups.
6. Suggested next scope.

## Ranking and Question Selection

Question selection should balance:

1. Relevance to selected scope.
2. Frequency in real interview reports.
3. Recency.
4. Difficulty progression.
5. User weaknesses from memory profile.
6. Coverage diversity.

Suggested V1 ranking:

```text
score =
  0.30 topic_match
+ 0.20 role_stage_match
+ 0.15 interview_frequency
+ 0.15 user_weakness_match
+ 0.10 recency
+ 0.10 source_quality
```

V1 can implement this deterministically before the AI call. The AI should adapt selected seeds, not choose from the whole corpus blindly.

## Implementation Plan

### Phase 1: Corpus Import and Read-Only Preview

Add an offline import script:

`scripts/import-nowcoder-loopassist-corpus.mjs`

Output:

```text
data/loopassist/interview-reports.jsonl
data/loopassist/question-seeds.jsonl
data/loopassist/manifest.json
```

The script should:

1. Read `newcode-craw/data/nowcoder_interviews.jsonl`.
2. Deduplicate by `content_id` and normalized text.
3. Extract company, stage, role path, topics, and question-like lines.
4. Filter reports with too little useful text.
5. Preserve source URL and metrics.

### Phase 2: Selection UI

Add a LoopAssist setup screen:

`/loopassist`

The first usable version should include:

1. Role selector.
2. Stage selector.
3. Topic chips.
4. Company-style filter.
5. Interview style selector.
6. Preview panel with sample questions.

### Phase 3: Start Session Integration

Add BFF endpoints:

1. `GET /api/loopassist/options`
2. `POST /api/loopassist/preview-scope`
3. `POST /api/loopassist/start`
4. `POST /api/loopassist/answer`
5. `POST /api/loopassist/answer-stream`
6. `POST /api/loopassist/review`

Reuse existing interview session projection and streaming infrastructure after start, but keep per-turn output as interviewer text. The review endpoint is where structured assessment belongs.

### Phase 4: Answer Evaluation Extensions

Extend AI prompts so the final review can say:

1. "你答到了什么"
2. "漏了什么"
3. "真实面试里这个问题通常继续追问什么"
4. "真实面试里下一问可能是什么"

The per-turn interviewer prompt should not produce machine-readable scoring or user-visible evaluation. It should only produce the next interviewer message.

## First Version Scope

The first version should be:

1. Voice-first interview with text fallback.
2. Real interview reports + LLM interviewer.
3. No user-document grounding.
4. No arbitrary GitHub repo ingestion.
5. No requirement that voice is the only path.
6. No company-specific perfect simulator.

External retrieval, user documents, and open-source project support should be treated as later layers. Keep V1 focused until the report-derived interview loop is clearly good.

## Why This Scope Is Right

If V1 ships only "面经随机出题", it will feel shallow.

If V1 tries "AI understands any GitHub repo and interviews you live", it will get dragged into indexing, retrieval, code parsing, hallucination control, and latency.

The right first product is:

User picks a scope. LoopAssist chooses grounded seeds. The LLM interviews from those seeds, probes the answer, and explains what a stronger candidate would have said.

That is small enough to build, and strong enough to feel new.

## Risks

### Risk 1: Noisy Interview Reports

Many interview reports are short, duplicated, promotional, or vague.

Mitigation:

1. Filter low-text reports.
2. Deduplicate exact and near-exact content.
3. Extract question seeds rather than using whole reports as learning docs.
4. Keep source preview transparent.

### Risk 2: AI Asks Generic Questions

If the model sees a large context blob, it may produce generic textbook questions.

Mitigation:

1. Select question seeds deterministically first.
2. Force every generated question to cite a seed/source.
3. Reject questions without source refs in validation.

### Risk 3: LLM Over-Explains Too Early

If the question screen shows strong-answer signals too early, the session becomes a study card instead of an interview.

Mitigation:

1. Keep source grounding internal during the interview.
2. Show strong-answer signals only after answering.
3. Use review drawer instead of always-visible answer notes.

### Risk 4: External Retrieval Scope Creeps In Too Early

External retrieval is tempting, but it adds freshness, citation quality, latency, and source trust problems before the core loop is proven.

Mitigation:

Keep retrieval disabled in V1. Add it only after report-derived question selection, answer evaluation, and review UX are working.

## Success Criteria

V1 is working if:

1. A user can choose role, stage, topics, company style, and interview style in under 60 seconds.
2. At least 80% of generated questions have visible source grounding.
3. The first question feels like a real interview question, not a study-card prompt.
4. Final review gives concrete stronger-answer outlines for weak answers.
5. The session can run for 5-8 questions without repeating the same topic.

## Recommended Product Positioning

Call the feature:

`LoopAssist`

Short description:

`用真实面经生成一场可追问、可复盘的模拟面试。`

Internal framing:

LoopAssist is not a question bank. It is an assessment scope engine.

That framing matters because the durable value is not the individual generated question. It is the user's ability to choose a meaningful scope and receive a grounded interview loop.
