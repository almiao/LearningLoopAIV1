# Scripts

This directory intentionally stays small.

## Core startup

| File | Purpose |
| --- | --- |
| `service-runtime.mjs` | Shared split-services runtime helpers |
| `start-services.mjs` | Start frontend, BFF, superapp, and AI service |
| `stop-services.mjs` | Stop tracked split services |

## Unified non-core tools

| File | Purpose |
| --- | --- |
| `project-tools.mjs` | Consolidated `build`, `test`, `smoke:split`, `validate:cases`, and `eval:auto` entrypoint |

## Removed surface

- One-off and duplicated maintenance/eval scripts were removed instead of keeping per-task wrappers in this directory.
