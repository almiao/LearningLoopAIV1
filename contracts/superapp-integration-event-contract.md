# Superapp Integration Event Contract (V1)

This document defines the v1 event model for the independent superapp integration capability.

The event model exists to support three things:

- product measurement
- debugging across service boundaries
- replayable evaluation of reminder -> click -> first-question -> reply progression

## Design Principles

1. Events should describe the Feishu superapp path independently from browser learning sessions.
2. Events should separate:
   - reminder lifecycle
   - click/open lifecycle
   - private-chat conversation lifecycle
3. A clicked reminder with no reply must be representable as a first-class partial-success state.
4. v1 event semantics assume Feishu via OpenClaw, not a multi-channel abstraction.

## Shared Event Envelope

All events should carry at least:

```json
{
  "eventId": "evt-123",
  "eventType": "reminder_opened",
  "occurredAt": "2026-04-14T15:26:45Z",
  "userId": "user-123",
  "channel": "feishu",
  "reminderId": "rem-123",
  "conversationId": "conv-123",
  "taskId": "task-001",
  "correlationId": "corr-123"
}
```

## Core Entities

### Reminder

- `reminderId`
- `userId`
- `channel`
- `taskId`
- `category`
- `conceptId`

### Conversation

- `conversationId`
- `reminderId`
- `userId`
- `channel`
- `currentQuestionId`
- `state`

### Task

- `taskId`
- `category`
- `conceptId`
- `conceptTitle`

## Event Types

### 1. `reminder_candidate_selected`

When:

- one v1 reminder task is chosen for a learner

Required fields:

```json
{
  "eventType": "reminder_candidate_selected",
  "category": "yesterday_gap_followup",
  "conceptId": "aqs-acquire-release",
  "selectionReason": "昨天缺口追击"
}
```

### 2. `reminder_composed`

When:

- reminder copy is generated and linked to one task

Required fields:

```json
{
  "eventType": "reminder_composed",
  "messagePreview": "你昨天在 AQS 上只答到了锁框架，今天补 state + 队列这一点就够了。",
  "estimatedMinutes": 5
}
```

### 3. `reminder_sent`

When:

- reminder is handed off to the superapp delivery path

Required fields:

```json
{
  "eventType": "reminder_sent",
  "deliveryProvider": "openclaw",
  "deliveryStatus": "accepted"
}
```

### 4. `reminder_opened`

When:

- the user clicks/opens the reminder

Required fields:

```json
{
  "eventType": "reminder_opened",
  "openClawConversationId": "oc-conv-001"
}
```

### 5. `first_question_requested`

When:

- superapp-service asks AI service for the post-click first question

Required fields:

```json
{
  "eventType": "first_question_requested",
  "questionStrategy": "direct_replyable_v1"
}
```

### 6. `first_question_shown`

When:

- the first directly replyable question becomes visible in private chat

Required fields:

```json
{
  "eventType": "first_question_shown",
  "questionId": "q-001",
  "hasBackground": true
}
```

### 7. `first_reply_received`

When:

- learner sends the first reply in private chat

Required fields:

```json
{
  "eventType": "first_reply_received",
  "questionId": "q-001",
  "replyLength": 18
}
```

### 8. `first_loop_completed`

When:

- the learner has received the first bounded continuation message after first reply

Required fields:

```json
{
  "eventType": "first_loop_completed",
  "resolution": "continue",
  "replyMode": "gap_correction"
}
```

### 9. `conversation_marked_partial_success`

When:

- reminder was opened, but no meaningful continuation happened after the first question

Required fields:

```json
{
  "eventType": "conversation_marked_partial_success",
  "outcomeState": "click_only"
}
```

### 10. `conversation_closed`

When:

- v1 conversation is explicitly closed or aged out

Required fields:

```json
{
  "eventType": "conversation_closed",
  "outcomeState": "click_only"
}
```

## Outcome States

The event model should support these normalized states:

- `sent_only`
- `opened`
- `question_shown`
- `click_only`
- `first_reply_received`
- `first_loop_completed`

## Product Metric Mapping

### Primary metric

- `reminder_opened / reminder_sent`

### Secondary metrics

- `first_question_shown / reminder_opened`
- `first_reply_received / reminder_opened`
- `first_loop_completed / reminder_opened`

### Partial-success definition

Use:

- `conversation_marked_partial_success`

for cases where the reminder is opened but the learner does not continue into a meaningful learning step.

## Service Emission Ownership

### BFF

May emit:

- reminder outcome persistence acknowledgements

### AI Service

May emit:

- `first_question_requested` completion traces
- thin continuation result traces

### Superapp-Service

Must emit the canonical business events for:

- reminder selection
- reminder send
- reminder open
- first question shown
- first reply received
- first loop completed
- partial success marking

## Non-goal Event Types

Do not add v1 event types for:

- group chat joins
- multi-user learning rooms
- advanced personalization-policy evaluation
- non-Feishu channel routing
- rich lesson-session progress beyond the first bounded loop

## Release Gate

The v1 event model is acceptable only if one testable conversation can be reconstructed from events through this sequence:

`reminder_candidate_selected -> reminder_composed -> reminder_sent -> reminder_opened -> first_question_shown`

and a second branch can represent:

`reminder_opened -> first_question_shown -> conversation_marked_partial_success`
