# Interview API Contract (Phase 1 Split)

This contract defines the minimum cross-service API needed for the runnable main flow.

## Frontend -> BFF

### `POST /api/auth/login`

Request:

```json
{
  "handle": "lee_backend",
  "pin": "1234"
}
```

Response:

```json
{
  "created": true,
  "profile": {
    "user": {},
    "summary": {},
    "targets": []
  }
}
```

### `GET /api/profile/:userId`

Response:

```json
{
  "user": {},
  "summary": {},
  "documentProgress": {},
  "targets": []
}
```

### `POST /api/interview/start-target`

Request:

```json
{
  "userId": "user-123",
  "docPath": "docs/ai/agent/mcp.md",
  "interactionPreference": "balanced"
}
```

Response:

```json
{
  "sessionId": "session-123",
  "currentProbe": "question",
  "currentQuestionMeta": {},
  "targetBaseline": {},
  "targetMatch": {},
  "concepts": [],
  "summary": {}
}
```

### `POST /api/interview/answer`

Request:

```json
{
  "sessionId": "session-123",
  "answer": "user answer",
  "burdenSignal": "normal",
  "interactionPreference": "balanced"
}
```

Response:

```json
{
  "sessionId": "session-123",
  "currentProbe": "next question",
  "latestFeedback": {},
  "targetMatch": {},
  "abilityDomains": [],
  "nextSteps": []
}
```

### `POST /api/interview/focus-domain`

Request:

```json
{
  "sessionId": "session-123",
  "domainId": "database-core"
}
```

### `POST /api/interview/focus-concept`

Request:

```json
{
  "sessionId": "session-123",
  "conceptId": "mvcc-repeatable-read"
}
```

### `GET /api/interview/:sessionId`

Returns the current projected session view.

## BFF -> AI Service

All interview endpoints proxy to the AI service under the same path shape:

- `POST /api/interview/start-target`
- `POST /api/interview/answer`
- `POST /api/interview/focus-domain`
- `POST /api/interview/focus-concept`
- `GET /api/interview/:sessionId`

### AI start-target payload

```json
{
  "userId": "user-123",
  "source": {},
  "decomposition": {},
  "targetBaseline": {},
  "memoryProfile": {},
  "interactionPreference": "balanced"
}
```

### AI answer payload

```json
{
  "sessionId": "session-123",
  "answer": "user answer",
  "burdenSignal": "normal",
  "interactionPreference": "balanced"
}
```

### AI answer response extension

The AI service may include:

```json
{
  "memoryProfileSnapshot": {}
}
```

The BFF persists this snapshot and strips it before responding to the frontend.
