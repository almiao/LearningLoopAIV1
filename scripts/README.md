# Scripts

This directory contains manual utilities and verification runners.

## Active scripts

| File | Purpose |
| --- | --- |
| `generate-multitopic-long.mjs` | Multi-domain visible transcript stress run against the live BFF |
| `generate-session-dossiers.mjs` | Generate deterministic session review dossiers into `tests/eval/generated/` |
| `generate-two-domain-visible.mjs` | Two-domain visible transcript run against the live BFF |
| `run-automated-eval.mjs` | Automated persona-based evaluation runner |
| `simulate-learner-session.mjs` | LLM-driven learner simulation against the local JS tutor service |
| `smoke-split-services.mjs` | Split runtime smoke check |
| `validate-case-library.mjs` | Validate JSON user-case documents in `tests/cases/` |

## Archived scripts

- Historical AQS legacy comparison tooling was moved to `../archive/legacy-aqs-evaluation/`.

## Naming rule

- Script names use verb-first kebab-case and stay grouped by intent: `generate-*`, `run-*`, `simulate-*`, `validate-*`, `smoke-*`.
