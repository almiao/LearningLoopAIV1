# Shared JS Engine

`src/` contains the shared JavaScript tutoring engine used by tests, scripts, the BFF, and some frontend view projection code.

## Folder map

| Directory | Purpose |
| --- | --- |
| `baseline/` | Baseline pack definitions and target-role source material |
| `ingestion/` | Document parsing and URL ingestion |
| `material/` | Concept decomposition and source-to-material normalization |
| `tutor/` | Core tutoring/session orchestration logic |
| `user/` | User profile persistence and projection helpers |
| `view/` | Session transcript and visible session view builders |

## Notes

- Empty placeholder directories from older planning (`shared/`, `targets/`, `ui/`) were removed.
- This folder is still active and imported throughout the repository.
