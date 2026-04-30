# AI Service

`ai-service/` contains the Python FastAPI service used by the split runtime.

## Runtime boundary

- Training content generation, question generation, answer diagnosis, and answer evaluation belong here.
- Document decomposition produces compact concept anchors only: title, summary, evidence snippet, misconception anchors, discriminators, and importance.
- Learner-facing questions are generated at runtime from the current session state; any pre-authored diagnostic/check questions are compatibility fallbacks, not the primary prompt source.
- A configured LLM provider is required in production.
- Heuristic tutor intelligence is available only as a test double under test-only environment flags.

## Folder map

| Directory | Purpose |
| --- | --- |
| `app/` | Application package and HTTP entrypoint |
| `app/core/` | Configuration and tracing bootstrap |
| `app/domain/` | Domain-level parsing and validation rules |
| `app/domain/interview/` | Interview request parsing and validation helpers |
| `app/engine/` | Python-side tutor engine modules and session logic |
| `app/infra/` | Infrastructure adapters |
| `app/infra/llm/` | LLM client and snapshot handling |
| `app/observability/` | Logging and event emission |
| `tests/` | Python-side verification for the tutor flow |

## Notes

- The Python service mirrors part of the shared JS domain model, but it is a separate runtime surface.
- Shared contract docs live in [`../contracts/README.md`](../contracts/README.md).
