# Tests

This directory groups product verification, evaluation tooling, and human review assets.

## Folder map

| Directory | Purpose |
| --- | --- |
| `cases/` | Structured user-case JSON inputs and the human review rubric |
| `e2e/` | End-to-end flows and artifact generation checks |
| `eval/` | Automated persona evaluation scenarios and scoring helpers |
| `eval/generated/` | Runtime output directory for generated evaluation artifacts |
| `fixtures/` | Shared test materials |
| `helpers/` | Shared helpers used by tests |
| `integration/` | Cross-module and cross-service integration tests |
| `integration/ai-service/` | Split runtime parity and observability checks |
| `integration/ingestion/` | Source normalization and ingestion behavior |
| `integration/user/` | User/profile integration tests |
| `personas/` | Automated evaluation personas |
| `unit/` | Focused module-level tests |
| `unit/frontend/` | View projection unit tests |
| `unit/ingestion/` | Ingestion unit tests |
| `unit/tutor/` | Memory profile persistence unit tests |

## Notes

- `tests/eval/generated/` should be treated as generated output, not long-term documentation.
- Historical committed review snapshots were moved to `../archive/session-review-snapshots/`.
