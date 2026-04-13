# Tests

This directory groups product verification, evaluation tooling, and human review assets.

## Folder map

| Directory | Purpose |
| --- | --- |
| `cases/` | Structured user-case JSON inputs and the human review rubric |
| `e2e/` | End-to-end flows and artifact generation checks |
| `eval/` | Deterministic review scenarios and dossier generation helpers |
| `eval/generated/` | Runtime output directory for generated review artifacts |
| `fixtures/` | Shared test materials |
| `helpers/` | Shared helpers used by tests |
| `integration/` | Cross-module and cross-service integration coverage |
| `integration/ai-service/` | Split runtime parity and observability checks |
| `integration/ingestion/` | Source normalization and ingestion behavior |
| `integration/tutor/` | Shared tutor engine integration tests |
| `integration/user/` | User/profile integration tests |
| `personas/` | Automated evaluation personas |
| `unit/` | Focused module-level tests |
| `unit/frontend/` | View projection unit tests |
| `unit/ingestion/` | Ingestion unit tests |
| `unit/material/` | Material decomposition unit tests |
| `unit/tutor/` | Tutor engine unit tests |

## Notes

- `tests/eval/generated/` should be treated as generated output, not long-term documentation.
- Historical committed review snapshots were moved to `../archive/session-review-snapshots/`.
