# Frontend

`frontend/` contains the Next.js web client.

## Folder map

| Directory | Purpose |
| --- | --- |
| `app/` | App Router routes, layout, and page-level entrypoints |
| `app/profile/` | Profile route |
| `components/` | Reusable UI shell components |
| `lib/` | Browser-side API helpers |

## Notes

- Build output in `.next/` and installed packages in `node_modules/` are generated locally and should not be committed.
- Some display projection logic is imported from the shared `../src/view/` modules.
