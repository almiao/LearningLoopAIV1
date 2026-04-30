# Automated Evaluation

This directory contains automated persona evaluation tooling for the split-service training flow.

## Boundary

- Product training logic lives in `ai-service/`.
- BFF-facing automated evaluations live in `tests/eval/` and `scripts/`.
- Review flags and scorecards are human aids, not runtime product behavior.

## What lives here

| File or directory | Purpose |
| --- | --- |
| `scenarios.js` | Curated scenario descriptions used by review and future eval work |
| `automated-eval.js` | Persona-driven BFF evaluation runner |
| `generated/` | Runtime output directory for generated evaluation artifacts |

## Workflow

1. Start the split services.
2. Run `npm run eval:auto`.
3. Review the generated output directory and compare weak runs against `tests/cases/user-case-rubric.md`.
4. Fix product behavior in `ai-service/`, then rerun the evaluation.

## Archiving policy

- Generated outputs are disposable.
- Previously committed sample outputs were moved to `archive/session-review-snapshots/`.
- Keep only the runtime output directory in the active tree.
- Evaluation heuristics are review aids only; they must not be promoted into production tutor generation or answer evaluation.
