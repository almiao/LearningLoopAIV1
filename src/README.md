# Shared JS Domain Helpers

`src/` contains shared JavaScript domain helpers used by tests, scripts, the BFF, and some frontend view projection code.

## Folder map

| Directory | Purpose |
| --- | --- |
| `baseline/` | Baseline pack definitions and target-role source material |
| `ingestion/` | Document parsing and URL ingestion |
| `material/` | Source normalization primitives used by ingestion and baseline packs |
| `tutor/` | Memory profile shape and persistence helpers used by the BFF |
| `user/` | User profile persistence and projection helpers |
| `view/` | Session transcript and visible session view builders |

## Notes

- Empty placeholder directories from older planning (`shared/`, `targets/`, `ui/`) were removed.
- This folder is still active and imported throughout the repository.
- Production training intelligence belongs in `ai-service/`; JavaScript tutor orchestration has been removed.
