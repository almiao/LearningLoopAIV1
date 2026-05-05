# Training Message Protocol (Frozen V1)

This document freezes the learner-facing message contract for the training flow.

Scope:

- `POST /api/interview/answer-stream`
- projected training session payloads returned by `answer_session()`
- frontend training chat rendering in `frontend/components/learn-workspace.js`

The goal is simple: one learner action may trigger a multi-stage backend workflow, but the UI must still feel append-only, ordered, and trustworthy.

Frozen direction:

- the frontend is append-only
- learner-visible messages are emitted by the backend in real time
- the backend, not the frontend, controls which weak/strong messages are exposed during processing

## Core Rules

1. The backend owns durable history.
2. The frontend must treat the chat list as append-only.
3. Learner-visible messages should originate from backend events, not frontend inference.
4. If a backend-emitted message should remain visible after the round finishes, the backend must append a corresponding turn into `session.turns`.
5. A later snapshot must preserve the same relative order the learner saw during streaming for the same round.
6. The frontend must not synthesize, sort, backfill, or merge durable turns after the backend has emitted them.

## Message Classes

### Strong messages

Strong messages carry learner-facing content that should remain meaningful on replay.

- learner `answer`
- learner `control`
- tutor `evaluation`
- tutor `feedback`
- tutor `question`
- tutor `memory`

### Weak messages

Weak messages describe system progress or execution state. They are still append-only if exposed to the learner, but they are visually subordinate to strong messages.

- tutor `process`
- tutor `progress`

## Message Inventory

Current learner-visible training messages are limited to the following catalog.

| Role | Kind | Action | Class | Source | Purpose |
| --- | --- | --- | --- | --- | --- |
| `tutor` | `feedback` | `intro` | strong | `build_training_decomposition_intro()` | Session opening summary before the first question |
| `tutor` | `progress` | `progress` | weak | `build_progress_message()` | Checkpoint / training-point transition cue |
| `tutor` | `question` | `probe` | strong | `currentProbe` | The next learner-facing question |
| `learner` | `answer` | `""` | strong | submitted answer text | Normal learner response |
| `learner` | `control` | `teach` / `advance` | strong | submitted control text | Explicit learner intent like `查看解析` / skip |
| `tutor` | `process` | `process` | weak | streamed progress callback | Real-time backend workflow disclosure |
| `tutor` | `evaluation` | `evaluate` | strong | `build_evaluation_message()` | Compact scoring verdict for a normal answered round |
| `tutor` | `feedback` | `teach` / `check` / `repair` / `deepen` / `advance` | strong | `latest_feedback.explanation` | Main tutor explanation / correction / continuation message |
| `tutor` | `feedback` | `complete` | strong | `build_scope_completion_message()` | Single final summary for the completed training scope |
| `tutor` | `memory` | `memory` | strong | `build_memory_summary_message()` | Visible memory writeback / weakness / contradiction summary |
| `system` | `workspace` | `focus-domain` / `focus-concept` | event | `create_workspace_turn()` | Non-chat context switch row |

Anything outside this catalog should be treated as a protocol change and reviewed explicitly.

## Formatting Rules

### Strong message rules

- A strong message must stand on its own when replayed later from history only.
- `question` is the only message kind that may directly ask the learner for the next response.
- `evaluation` should stay compact: verdict first, then one key claim, then one misconception if needed.
- `feedback` is the main answer body. It should not be hidden inside weak messages.
- `feedback:complete` is the only learner-visible training completion summary. It must include the scoped result distribution, representative accurate/review concepts, memory writeback summary, and how the current system will use memory for the next training run.
- `memory` should summarize what the system will remember or revisit, not restate the whole answer.

### Weak message rules

- Weak messages explain system work in progress or context transition.
- Weak messages must be short, single-purpose, and present-tense.
- Weak messages must not contain the primary teaching payload of the round.
- Weak messages may appear multiple times in one round, but each one should correspond to a distinct backend phase update.

### Wording rules

- Prefer concrete operational wording over abstract internal jargon.
- Do not expose model-internal reliability machinery unless the product explicitly wants it visible.
- If a message tells the learner that the system is doing something next, that step must be reflected by later turns in the same round or the next round.

## Streamed Weak-Phase Model

The backend currently uses these progress phases for real-time learner-visible weak messages:

| Phase | Typical label | Meaning |
| --- | --- | --- |
| `intent` | `识别你的请求` | The system recognized a control request such as `查看解析` |
| `reply` | `生成反馈` / `生成解析` | The system is generating the main tutor response |
| `assessment` | `判断掌握度` | The system is judging answer quality / gaps |
| `next_step` | `决定下一步` / `安排下一步` | The system is choosing whether to continue, switch, or stop |

These phases may emit `running` or `completed` statuses in raw stream data, but the training UI chat should treat them as append-only weak `process` turns.

## Round State Machines

### Session start

Required order:

1. `tutor feedback:intro`
2. `tutor progress:progress`
3. `tutor question:probe`

### Normal learner answer round

Required partial order:

1. `learner answer`
2. zero or more weak `tutor process:process`
3. optional `tutor evaluation:evaluate`
4. required `tutor feedback:*`
5. optional `tutor memory:memory`
6. optional `tutor progress:progress`
7. optional `tutor question:probe`
8. optional `tutor feedback:complete` when the scoped training range ends

Notes:

- `evaluation` must appear before `feedback` if both exist.
- `memory` must appear after `feedback`.
- `progress` must appear immediately before the next `question` if the round continues.
- `feedback:complete` must appear after the last feedback/memory turn and must not be followed by another `question` in the same scoped run.
- Only an answer classified as `wrong` may stay on the same checkpoint and emit an immediate corrective follow-up.
- `full`, `partial`, and `empty` outcomes must advance to the next checkpoint or stop the scope; they may write memory or schedule later review, but they must not ask an immediate same-checkpoint question.

### Teach control round

Required partial order:

1. `learner control:teach`
2. one or more weak `tutor process:process`
3. required `tutor feedback:teach`
4. optional `tutor progress:progress`
5. optional `tutor question:probe`
6. optional `tutor feedback:complete` when the scoped training range ends

Notes:

- `teach` rounds must not emit `evaluation`.
- `teach` rounds should normally not emit `memory`.
- `teach` rounds must not emit a same-checkpoint `teach-back` question in the same round.
- After the explanation, `teach` must advance to the next checkpoint or stop the scope with a completion summary.

### Advance control round

Required partial order:

1. `learner control:advance`
2. required `tutor feedback:advance`
3. optional `tutor progress:progress`
4. optional `tutor question:probe`

## Forbidden Transitions

- No `question` before the learner’s triggering turn is appended.
- No `feedback` after a follow-up `question` for the same round.
- No same-checkpoint immediate follow-up unless the current answer outcome is `wrong`.
- No same-round `teach-back` prompt after `teach` / `查看解析`; save that need for memory or a later review path.
- No `evaluation` in a `teach` round.
- No frontend-synthesized learner-visible training messages outside backend `turn_append`.
- No frontend-synthesized completion summary. Frontend may render controls after completion, but must not restate counts, scoring, memory, or takeaway as chat copy.
- No reordering of strong messages after they have been emitted.
- No replacement of an already shown weak message with a later stronger message; append a new turn instead.
- No hidden follow-up question in metadata only. If the learner is expected to answer, a visible `question` turn must be appended.

## Compatibility Boundary

The stream may still carry non-chat compatibility events such as `assessment_preview` or `turn_result`.

- `turn_append` is the only canonical learner-visible append signal.
- `turn_result` is for session snapshot reconciliation.
- Non-chat compatibility events must not become visible chat rows unless they are promoted into a cataloged turn kind/action above.

## Round Model

One frontend action may produce multiple backend messages before the round completes.

Canonical shape:

1. learner action arrives
2. backend emits zero or more weak messages while processing
3. backend emits zero or more strong messages with the result
4. backend emits the next weak/strong transition messages needed to continue the workflow
5. round closes

The backend may stream these stages incrementally, but the persisted `session.turns` order must match the learner-visible order for that same round.

This means the backend may emit:

- weak messages early, while downstream model calls are still running
- strong messages as soon as each result is available
- follow-up weak/strong messages for the next workflow step before the HTTP round closes

## Stream Event Shape

For training answer streaming, the canonical transport events are:

- `turn_append`
- `turn_patch`
- `turn_result`
- `error`

Compatibility events may still exist during migration, but new UI work should treat `turn_append` as the primary learner-visible append signal.

`turn_append` payload:

```json
{
  "turn": {
    "turnId": "turn_123",
    "role": "tutor",
    "kind": "process",
    "action": "process",
    "content": "正在判断你这次回答里已经说对了什么、还缺什么。"
  }
}
```

`turn_patch` payload:

```json
{
  "turnId": "turn_123",
  "delta": "后续 AI chunk",
  "content": "当前这条消息的完整累积内容"
}
```

Use `turn_patch` only to grow the content of an already appended in-flight turn. It must not reorder turns or mutate them into a different kind/action.

## Teach Control Ordering

For `teach` / `查看解析`, the preserved order is:

1. learner `control`
2. tutor weak `process` messages explaining the mode switch / in-flight work
3. tutor strong `feedback` with the explanation itself
4. optional tutor weak `progress` for the next checkpoint state
5. optional tutor strong `question` for the next checkpoint only

The feedback must not jump ahead of already-shown weak process messages when the final session snapshot arrives.

## Frontend Responsibilities

- Render durable turns exactly in array order.
- Use styling, not reordering, to distinguish weak vs strong messages.
- Temporary streaming hints are allowed only for the in-flight round.
- Temporary hints must disappear once backend-owned durable turns for that round arrive.
- Completion UI is controls-only. The final training summary belongs to backend `feedback:complete`.

## Backend Responsibilities

- Append turns in learner-visible order.
- Keep turn creation centralized in the session engine.
- Prefer explicit weak turns over frontend inference for workflow state.
- Treat ordering regressions as contract breaks and cover them with tests.
- Complete a scoped run with exactly one `feedback:complete` turn that explains what was practiced, which checkpoints were accurate / need reinforcement / need calibration / skipped, what was written to long-term memory, and how current next-run entry points select questions.
- Do not invent completion statistics. Derive them from `conceptStates.result` and `memoryProfile.abilityItems[*].state`, and state product limitations honestly when the current routing does not yet reorder the full next run by weakness.
