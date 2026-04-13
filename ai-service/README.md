# AI Service

`ai-service/` contains the Python FastAPI service used by the split runtime.

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
