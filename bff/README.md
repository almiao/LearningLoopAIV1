# BFF

`bff/` is the Node.js backend-for-frontend layer.

## Folder map

| Directory | Purpose |
| --- | --- |
| `src/` | HTTP server entrypoint, cross-service proxying, and integration with shared JS modules |

## Notes

- The BFF imports active logic from `../src/`; that directory is part of the running system, not leftover code.
- Runtime scripts are defined in `package.json`.
