---
name: learningloop-superapp
description: Use LearningLoopAI from OpenClaw private chat for Feishu/WeChat knowledge Q&A, smart learning reminders, and one-question learning loops. Use when the user wants to ask JavaGuide/LearningLoopAI questions from Feishu/WeChat, start today's task, continue a reminder, or test the superapp private-chat learning flow.
user-invocable: true
metadata: { "openclaw": { "emoji": "📚" } }
---

# LearningLoopAI Superapp Skill

This is a user-facing OpenClaw skill for using LearningLoopAI inside Feishu / WeChat private chat.

It is **not** primarily a development SOP. The main job is to let the user ask knowledge questions and enter a lightweight learning loop from chat.

## Core Product Behavior

- Answer direct knowledge questions from private chat.
- Start a small learning task when the user asks “今天学什么 / 开始今天任务”.
- Continue a reminder into one directly replyable question.
- Keep each response short and actionable.
- Feishu and WeChat use the same OpenClaw handoff model. Do not branch behavior by channel unless explicitly requested.

## Optional Skill Config

Read defaults from `~/.openclaw/openclaw.json` when present:

```jsonc
{
  "skills": {
    "entries": {
      "learningloop-superapp": {
        "enabled": true,
        "config": {
          "repoDir": "/Users/lee/IdeaProjects/LearningLoopAIV1",
          "superappUrl": "http://127.0.0.1:4100",
          "defaultChannel": "feishu",
          "userId": "optional-learningloop-user-id",
          "demoUserId": "leave-empty-to-auto-fetch"
        }
      }
    }
  }
}
```

- `superappUrl` defaults to `http://127.0.0.1:4100`.
- `defaultChannel` defaults to `feishu`; `wechat` uses the same flow.
- If `userId` is missing, direct knowledge Q&A can still work.
- If starting today’s task and no `userId` is configured, fetch the demo user from:

```http
GET http://127.0.0.1:4000/api/superapp/demo-user
```

- For local trial, do not make the user click a reminder link. Start today’s task by directly requesting the first question.
- Do not ask the user to paste secrets or API keys into chat.

## Main Workflows

### 1. Direct Knowledge Q&A

Use when the user asks a learning question, for example:

- “AQS 为什么不是一把锁？”
- “帮我解释 JavaGuide 里的 AQS state”
- “这段文档是什么意思？”

Call:

```http
POST {superappUrl}/api/chat/ask
```

Payload:

```json
{
  "userId": "<config.userId or empty>",
  "channel": "<config.defaultChannel or feishu>",
  "question": "<user question>",
  "context": "<optional material/background>"
}
```

Return `answer.content` to the user. If `answer.suggestedFollowUp` exists, offer it as the next short action.

### 2. Start Today's Task

Use when the user says:

- “开始今天任务”
- “今天学什么”
- “继续学习”
- “复习错题”

Call:

```http
POST {superappUrl}/api/tasks/start-today-task
```

Payload:

```json
{
  "userId": "<config.userId or empty>",
  "channel": "<config.defaultChannel or feishu>"
}
```

This returns the first question directly. For normal trial usage, do not ask the user to click the reminder manually.

### 3. Continue A Question

Use when the user answers a question produced by the reminder/opened flow.

Call:

```http
POST {superappUrl}/api/chat/reply
```

Payload:

```json
{
  "conversationId": "<conversationId>",
  "answer": "<user answer>"
}
```

Return `reply.content`.

## Response Style

- Keep replies concise.
- Prefer one question or one action at a time.
- If answering a concept, use this shape:
  1. direct answer
  2. one key mechanism
  3. one follow-up question or next action
- Do not turn private chat into long-form lecture unless the user explicitly asks.

## Local Project References

Resolve these paths under `repoDir` only when implementation context is needed:

- `contracts/superapp-integration-api-contract.md`
- `contracts/superapp-integration-event-contract.md`
- `superapp-service/src/server.js`
- `ai-service/app/main.py`

For ordinary knowledge Q&A, do not load implementation docs unless the user asks how the integration works.
