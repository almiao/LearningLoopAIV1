# Scoped QA Report: Memory Flow

- Date: 2026-04-24
- Target: `http://localhost:3000`
- Scope: homepage continue-learning card, reading page knowledge outline, profile memory surface
- Mode: report-only, no source edits

## Summary

The memory writeback path is not fully broken.

What works:
- Reading progress persists when the article is opened directly with the correct `doc` path.
- The homepage continue-learning card updates to the latest article.
- The resume CTA reopens the remembered article correctly.
- API/profile integration tests pass.

What is broken:
- The normal in-app article switching path from the reading page is unreliable, so users cannot consistently generate the memory update through the UI they actually use.

## Evidence Run

- Passing API tests:
  - `PORT=4000 node --test --test-timeout=120000 tests/integration/user/profile-flow.test.js`
- Failing browser test:
  - `E2E_USE_EXISTING_SERVICES=1 E2E_FRONTEND_PORT=3000 E2E_BFF_PORT=4000 npx playwright test tests/e2e/home-reading-memory.pw.spec.js --workers=1`

## Findings

### ISSUE-001 High

**Title:** Desktop reading-page outline shows unrelated global content instead of the current article outline

**User impact:** A user reading `Spring 事务详解` cannot use the normal “知识目录” path to jump to the next article, so the “remember what I just read” loop breaks on the main UI path.

**Repro:**
1. Log in.
2. Open `/learn?target=bigtech-java-backend&doc=docs/system-design/framework/spring/spring-transaction.md&autostart=1`
3. Click `知识目录`.

**Expected:** The panel should show headings or related article choices for the current Spring article, including the next reading target used by the memory flow.

**Actual:** The panel renders a long unrelated global content list with entries like blog posts and site-wide topics, not the current article’s outline.

**Evidence:**
- Screenshot: `.gstack/qa-reports/screenshots/qa-memory-outline-open.png`
- Failing Playwright artifact: `test-results/home-reading-memory.pw-hom-10209-er-reading-another-document-desktop-chromium/test-failed-1.png`
- Test failure: waiting for `getByRole('button', { name: 'IoC 与 AOP 详解' })`

### ISSUE-002 High

**Title:** Mobile reading-page outline toggle is blocked by overlay interception

**User impact:** On mobile, the user cannot reliably open the outline at all, so the memory flow is blocked before article switching even starts.

**Repro:**
1. Log in on mobile viewport.
2. Open the Spring reading page.
3. Tap `知识目录`.

**Expected:** The outline opens and is tappable.

**Actual:** Pointer events are intercepted by `qa-panel` / surrounding containers. The click retries until timeout.

**Evidence:**
- Screenshot: `test-results/home-reading-memory.pw-hom-10209-er-reading-another-document-mobile-chromium/test-failed-1.png`
- Playwright log shows:
  - `qa-panel ... intercepts pointer events`
  - `study-main ... intercepts pointer events`

## Diagnosis

This looks like a UI-path regression, not a core persistence failure.

Direct verification that still works:
- Opening `docs/system-design/framework/spring/ioc-and-aop.md` directly updates the homepage card to `你上次读到：IoC & AOP详解（快速搞懂）`
- Clicking the homepage resume CTA reopens the same remembered article correctly

Related screenshots:
- `.gstack/qa-reports/screenshots/qa-memory-home-resume-card.png`
- `.gstack/qa-reports/screenshots/qa-memory-after-resume-click.png`

## Recommendation

Fix the reading-page knowledge/outline surface first.

Priority order:
1. Restore correct outline/article-switch content on desktop.
2. Remove mobile pointer interception around the outline toggle.
3. Re-run `tests/e2e/home-reading-memory.pw.spec.js` after the UI fix.
