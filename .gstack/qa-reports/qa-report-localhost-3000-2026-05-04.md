# QA Report: localhost:3000 Document Training

Date: 2026-05-04
Target: http://127.0.0.1:3000
Scope: document-scoped training flow in `/learn`
Tier: Standard
Mode: full browser E2E with blocker fix and re-test

## Summary

Health score: 7/10 -> 9/10

Browsers used:
- Playwright Chromium desktop, 1440x1000

Documents tested:
- `docs/system-design/framework/spring/spring-transaction.md`
- `docs/cs-basics/data-structure/bloom-filter.md`

Primary checks:
- A document can resume/start training from the reading page.
- Repeated learner actions can advance through every checkpoint.
- The final UI shows `本轮训练结束`.
- The final training summary reports the correct completed checkpoint count.
- No browser console errors were emitted during verified runs.

## Evidence

Screenshots:
- `.gstack/qa-reports/screenshots/spring-transaction-training-start.png`
- `.gstack/qa-reports/screenshots/spring-transaction-training-complete.png`
- `.gstack/qa-reports/screenshots/spring-transaction-training-complete-after-fix.png`
- `.gstack/qa-reports/screenshots/bloom-filter-training-start.png`
- `.gstack/qa-reports/screenshots/bloom-filter-training-complete.png`

Verified completion text:
- Spring transaction: `已完成 14 / 14 个子项`
- Bloom filter: `已完成 14 / 14 个子项`

## Issues

### ISSUE-001: Training completion summary showed `0 / 14` after a completed BFF-backed document session

Severity: High
Status: Fixed and verified

Repro:
1. Start document-scoped training for `docs/system-design/framework/spring/spring-transaction.md`.
2. Use `查看解析` to advance through all 14 checkpoints.
3. Observe the completion card.

Before:
- The completion card appeared, but showed `已完成 0 / 14 个子项`.

Root cause:
- The frontend completion card only counted `session.conceptStates`.
- Real BFF responses expose projected `trainingPointStates`, while `conceptStates` is not present in the stripped payload.

Fix:
- Updated the completion summary calculation to fall back to `trainingPointStates` when checkpoint-level `conceptStates` are unavailable.

After:
- The same completed session now renders `已完成 14 / 14 个子项`.
- A second full document training run on Bloom Filter also renders `已完成 14 / 14 个子项`.

Files changed:
- `frontend/components/learn-workspace.js`

## Notes

- The Spring run used `查看解析` across the whole document, covering teach/control streaming and completion summary.
- The Bloom Filter run used `下一题` across the whole document, covering advance/control progression and completion summary.
- `gstack browse` was unavailable in this environment due a local `node:fs` loader failure, so the browser QA was performed with the project's Playwright Chromium setup.

## Remaining Risks

- Mobile document-training completion was not exhaustively re-run in this QA pass.
- The local user profile store logs several older malformed test profiles while scanning; this did not block the tested flows, but it is noise worth cleaning separately.
