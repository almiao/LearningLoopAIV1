# Shared JS Engine

`src/` contains shared JavaScript domain helpers used by tests, scripts, the BFF, and some frontend view projection code.

## Folder map

| Directory | Purpose |
| --- | --- |
| `baseline/` | Baseline pack definitions and target-role source material |
| `ingestion/` | Document parsing and URL ingestion |
| `material/` | Legacy/test source-to-material normalization helpers |
| `tutor/` | Tutor state, memory, turn protocol helpers, and legacy local-session test coverage |
| `user/` | User profile persistence and projection helpers |
| `view/` | Session transcript and visible session view builders |

## Notes

- Empty placeholder directories from older planning (`shared/`, `targets/`, `ui/`) were removed.
- This folder is still active and imported throughout the repository.
- New production training intelligence belongs in `ai-service/`, not in JS heuristic modules.
