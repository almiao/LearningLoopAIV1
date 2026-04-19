# Superapp Integration API Contract (V1)

This contract defines the minimum API slice for the independent superapp integration capability.

The intended runtime is:

- `superapp-service` as the channel-facing integration boundary
- `bff` as learner/progress context provider
- `ai-service` as first-question and thin continuation provider

## Design Rules

- Feishu and WeChat are the only supported chat channels in v1.
- Feishu and WeChat share the same capability model; v1 does not define channel-specific behavioral differences.
- OpenClaw is the external handoff boundary for Feishu / WeChat linking and routing.
- v1 supports:
  - direct private-chat knowledge Q&A
  - reminder/task dispatch
  - click/open handoff
  - private-chat first question
  - one bounded continuation loop

## BFF -> Superapp Support APIs

These are context APIs that `superapp-service` consumes from the BFF.

### `GET /api/superapp/reminder-candidate/:userId`

Purpose:

- return the best v1 reminder candidate for one learner

Response:

```json
{
  "userId": "user-123",
  "targetBaselineId": "bigtech-java-backend",
  "candidate": {
    "taskId": "task-001",
    "category": "yesterday_gap_followup",
    "title": "补一下 AQS 的 state + 队列",
    "reason": "你昨天在 AQS 上只答到了锁框架层，没有讲清 state 和排队协调。",
    "estimatedMinutes": 5,
    "conceptId": "aqs-acquire-release",
    "conceptTitle": "AQS acquire/release 语义",
    "materialContext": "AQS 不只是锁框架，还负责同步状态管理和线程排队协调。"
  }
}
```

### `POST /api/superapp/reminder-outcome`

Purpose:

- persist reminder delivery / click / continuation outcome into app-owned storage

Request:

```json
{
  "reminderId": "rem-123",
  "userId": "user-123",
  "status": "opened",
  "channel": "feishu",
  "conversationId": "conv-123",
  "openedAt": "2026-04-14T15:26:45Z"
}
```

Response:

```json
{
  "ok": true
}
```

## Superapp-Service Internal APIs

These are the primary runtime APIs exposed by `superapp-service`.

### `POST /api/chat/ask`

Purpose:

- answer a direct LearningLoopAI knowledge question from Feishu / WeChat private chat

Request:

```json
{
  "userId": "user-123",
  "channel": "feishu",
  "question": "AQS 为什么不是一把锁？",
  "context": "用户正在阅读 JavaGuide 的 AQS 文档。"
}
```

Response:

```json
{
  "conversationId": "conv-123",
  "channel": "feishu",
  "answer": {
    "mode": "knowledge_qa",
    "content": "AQS 不是一把具体的锁，而是同步器底座...",
    "suggestedFollowUp": "把这个点出成一道快答题"
  }
}
```

### `POST /api/tasks/start-today-task`

Purpose:

- directly start today’s task and return the first replyable question without requiring a manual reminder click

Request:

```json
{
  "userId": "user-123",
  "channel": "feishu"
}
```

If `userId` is omitted in local trial mode, `superapp-service` may resolve a demo user through the BFF.

Response:

```json
{
  "userId": "user-123",
  "channel": "feishu",
  "reminderId": "rem-123",
  "conversationId": "conv-123",
  "firstQuestion": {
    "questionId": "q-001",
    "content": "AQS 的作用是什么？",
    "background": "你最近还没建立稳定学习记录，先从这个最小切口开始。"
  }
}
```

### `POST /api/reminders/dispatch`

Purpose:

- dispatch one reminder for one learner or one selected candidate

Request:

```json
{
  "userId": "user-123",
  "channel": "feishu"
}
```

Response:

```json
{
  "reminderId": "rem-123",
  "status": "sent",
  "channel": "feishu",
  "openClawLink": "https://openclaw.example/link/abc",
  "candidate": {
    "taskId": "task-001",
    "category": "yesterday_gap_followup",
    "title": "补一下 AQS 的 state + 队列"
  }
}
```

### `POST /api/reminders/opened`

Purpose:

- resolve a reminder click/open and start the private-chat handoff

Request:

```json
{
  "reminderId": "rem-123",
  "channel": "feishu",
  "openClawConversationId": "oc-conv-001",
  "openedAt": "2026-04-14T15:26:45Z"
}
```

Response:

```json
{
  "conversationId": "conv-123",
  "firstQuestion": {
    "questionId": "q-001",
    "content": "AQS 的作用是什么？",
    "background": "你昨天提到它是锁框架，但还没讲到 state 和线程排队协调。"
  }
}
```

### `POST /api/chat/reply`

Purpose:

- receive one private-chat learner reply and continue the thin v1 loop

Request:

```json
{
  "conversationId": "conv-123",
  "questionId": "q-001",
  "userId": "user-123",
  "answer": "AQS 是通用同步器框架。"
}
```

Response:

```json
{
  "conversationId": "conv-123",
  "resolution": "continue",
  "reply": {
    "mode": "gap_correction",
    "content": "方向对，但还缺关键点：它还负责同步状态管理和线程排队协调。你再补一句它为什么能支撑多种同步器？"
  }
}
```

### `GET /api/conversations/:conversationId`

Purpose:

- lightweight debug/status endpoint for one superapp learning conversation

Response:

```json
{
  "conversationId": "conv-123",
  "userId": "user-123",
  "channel": "feishu",
  "status": "question_shown",
  "reminderId": "rem-123",
  "currentQuestionId": "q-001",
  "outcomeState": "click_only"
}
```

## Superapp-Service -> AI Service APIs

### `POST /api/superapp/answer-knowledge-question`

Purpose:

- answer a direct knowledge question from private chat

Request:

```json
{
  "userId": "user-123",
  "question": "AQS 为什么不是一把锁？",
  "context": "用户正在阅读 JavaGuide 的 AQS 文档。"
}
```

Response:

```json
{
  "mode": "knowledge_qa",
  "content": "AQS 不是一把具体的锁，而是同步器底座...",
  "suggestedFollowUp": "把这个点出成一道快答题"
}
```

### `POST /api/superapp/generate-first-question`

Purpose:

- generate the first directly replyable question from a selected reminder task

Request:

```json
{
  "userId": "user-123",
  "task": {
    "taskId": "task-001",
    "category": "yesterday_gap_followup",
    "conceptId": "aqs-acquire-release",
    "conceptTitle": "AQS acquire/release 语义",
    "reason": "你昨天在 AQS 上只答到了锁框架层，没有讲清 state 和排队协调。",
    "materialContext": "AQS 不只是锁框架，还负责同步状态管理和线程排队协调。"
  }
}
```

Response:

```json
{
  "questionId": "q-001",
  "content": "AQS 的作用是什么？",
  "background": "你昨天提到它是锁框架，但还没讲到 state 和线程排队协调。"
}
```

### `POST /api/superapp/continue-private-chat`

Purpose:

- produce one bounded continuation turn for the superapp path

Request:

```json
{
  "conversationId": "conv-123",
  "userId": "user-123",
  "questionId": "q-001",
  "question": "AQS 的作用是什么？",
  "answer": "AQS 是通用同步器框架。"
}
```

Response:

```json
{
  "resolution": "continue",
  "mode": "gap_correction",
  "content": "方向对，但还缺关键点：它还负责同步状态管理和线程排队协调。你再补一句它为什么能支撑多种同步器？",
  "loopState": "first_reply_processed"
}
```

## Out-of-Scope API Surface

This v1 contract explicitly does not define:

- group chat endpoints
- multi-user session APIs
- advanced reminder preference APIs
- Slack / Telegram / Discord / WhatsApp style non-Feishu-non-WeChat linking methods
- long multi-step tutoring workflows

## Release Gate

This contract is sufficient for v1 only if one end-to-end path can prove:

1. reminder candidate can be fetched
2. reminder can be dispatched
3. click/open can be recorded
4. first question can be generated and shown
5. one learner reply can be continued
