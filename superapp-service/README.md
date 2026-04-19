# Superapp Service

`superapp-service/` owns the channel-facing reminder and private-chat integration path.

## Responsibilities

- reminder dispatch orchestration
- OpenClaw handoff resolution
- click/open tracking
- private-chat first-question landing
- thin reply continuation
- reminder/conversation outcome state

## Notes

- It depends on `bff/` for learner + target context.
- It depends on `ai-service/` for first-question generation and bounded continuation text.
- It is intentionally isolated from the browser learning UI.
