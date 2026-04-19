# Contracts

This directory stores cross-service interface documents.

## Files

| File | Purpose |
| --- | --- |
| `interview-api-contract.md` | Frontend -> BFF and BFF -> AI service request/response contract for the split interview flow |
| `superapp-integration-api-contract.md` | Contract for the independent superapp-service reminder, click/open, and private-chat APIs |
| `superapp-integration-event-contract.md` | Event model for reminder lifecycle, click/open tracking, and private-chat continuation outcomes |

## Naming rule

- Contract files use descriptive kebab-case names ending with `-contract.md`.
