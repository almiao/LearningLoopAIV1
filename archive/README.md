# Archive

This directory stores historical material that is no longer part of the active workflow.

## Folder map

| Directory | Purpose |
| --- | --- |
| `legacy-aqs-evaluation/` | Old AQS comparison script and its legacy baseline data |
| `session-review-snapshots/` | Previously committed generated evaluation dossiers kept for reference |

## Rules

- Archived files stay read-only unless they need to be restored or referenced.
- Archived files are not active extension points. Do not import from `archive/` in production, tests, or scripts.
- New runtime-generated artifacts should not be committed back into active directories when an archive is more appropriate.
