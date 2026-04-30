# Session Review Loop

This directory contains deterministic evaluation tooling for the shared tutoring engine.

## Boundary

- Product logic lives in `src/`, `bff/`, and `ai-service/`.
- Review, replay, scoring, and dossier generation live in `tests/eval/` and `scripts/`.
- The review loop drives the public app-service surface instead of reaching into private internals.
- Review flags and scorecards are human aids, not runtime product behavior.

## What lives here

| File or directory | Purpose |
| --- | --- |
| `scenarios.js` | Deterministic review scenarios |
| `session-dossier.js` | Replay helpers, non-product heuristic scoring aids, and artifact writers |
| `generated/` | Runtime output directory for generated dossiers |

## Workflow

1. Run `npm run eval:sessions`.
2. Review `tests/eval/generated/index.md` and the per-scenario dossiers generated in the same folder.
3. Compare outputs against `tests/cases/user-case-rubric.md`.
4. Fix product behavior in active code, then rerun the review loop.

## Archiving policy

- Generated outputs are disposable.
- Previously committed sample outputs were moved to `archive/session-review-snapshots/`.
- Keep only the runtime output directory in the active tree.
- Evaluation heuristics are review aids only; they must not be promoted into production tutor generation or answer evaluation.
