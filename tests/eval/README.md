# Session Review Loop

This directory contains evaluation-only tooling for the tutor engine.

## Boundary

- Business code stays in `src/`.
- Review, replay, scoring, and dossier generation stay in `tests/eval/` and `scripts/`.
- The review loop only drives the public app service API exposed by `createAppService()`.
- Heuristic scorecards and review flags are advisory for humans. They are not product logic.

## What lives here

- `scenarios.js`: deterministic session review scenarios.
- `session-dossier.js`: replay helpers, heuristic scoring, and artifact writers.
- `generated/`: reviewable artifacts produced by `npm run eval:sessions`.

## Workflow

1. Run `npm run eval:sessions`.
2. Review `tests/eval/generated/index.md` plus the per-scenario JSON dossiers.
3. Compare the generated transcripts against `tests/cases/case-rubric.md`.
4. Fix product behavior in `src/`, then rerun the review loop.

## Why this split exists

The tutor engine should not know anything about regression dossier formats, batch review jobs, or human scoring rubrics. Keeping those capabilities outside `src/` lets us iterate on evaluation quickly without entangling product behavior and test infrastructure.
