# QA Report - Learning Page

- Date: 2026-05-01
- Target: `http://127.0.0.1:3000/learn?target=bigtech-java-backend&doc=docs/system-design/framework/spring/spring-transaction.md&autostart=1`
- Mode: Full browser QA, report-first
- Scope: Learning page UI, reading/training flow, copy, navigation, model output quality
- Environment: local frontend `:3000`, BFF `:4000`
- Health score: `78 / 100`

## Summary

The page loads and core routes work, but the current learning experience still feels split between "document reader" and "trainer" instead of feeling like one coherent product. The biggest problems are layout waste before training starts, overloaded navigation, slow training feedback, and tutor responses that explain too much and then ask again.

## What worked

- Desktop learning page loaded consistently with no reproducible desktop console errors.
- Heading jump from the outline worked.
- Focus mode produced a cleaner reading surface.
- Training mode did generate document-specific training points and sub-checkpoints.

## Top 3 things to fix

1. Make the pre-training state feel intentional. Right now the default split view gives too much space to an almost empty training rail.
2. Shorten and sharpen tutor replies. The system currently answers, teaches, and re-asks in the same turn.
3. Reduce training-turn latency. A learner should not sit in a blocked composer state for tens of seconds after a short answer.

## Findings

### ISSUE-001 - High - Empty training rail weakens the first-read experience

- Category: Visual, UX
- Fix status: deferred
- Evidence:
  - Screenshot: `.gstack/qa-reports/screenshots/learn-baseline.png`
- Repro:
  1. Open the learning page directly with a valid `target` and `doc`.
  2. Stay in the default pre-training state.
- Actual:
  - The article is squeezed into the left side while the right rail is mostly empty except for a title and composer.
  - The page looks unfinished before the learner has even decided to train.
- Expected:
  - Before training starts, reading should dominate the viewport, or the training rail should present a meaningful preview instead of large blank space.
- Why it matters:
  - This is the main learning surface. First impression is "half-built split screen" instead of "focused study product."

### ISSUE-002 - Medium - Outline mixes local navigation with the full 293-document corpus

- Category: UX, Information architecture
- Fix status: deferred
- Evidence:
  - Screenshot: `.gstack/qa-reports/screenshots/learn-outline-open.png`
- Repro:
  1. Open the learning page.
  2. Click `目录`.
- Actual:
  - The drawer starts with the current document headings, then immediately dumps the full global catalog below.
  - The two jobs, "jump inside this article" and "switch to another doc", are merged into one tall panel.
- Expected:
  - The current document outline should stay the primary action, with the full catalog separated more clearly or moved behind another explicit step.
- Why it matters:
  - This creates cognitive overload exactly when the learner wants lightweight wayfinding.

### ISSUE-003 - High - Training reply loop feels slow and blocks the learner

- Category: Functional, Performance
- Fix status: deferred
- Evidence:
  - Screenshot: `.gstack/qa-reports/screenshots/learn-training-feedback.png`
  - Screenshot: `.gstack/qa-reports/screenshots/learn-training-timeout-state.png`
- Repro:
  1. Click `开启训练`.
  2. Answer the first question with a short, relevant explanation.
  3. Wait for the next step.
- Actual:
  - The composer stays blocked while the system generates a long response and follow-up.
  - In testing, the turn did not settle within a short 30-second wait and only produced a stable post-answer state after a much longer delay.
- Expected:
  - A learner should get the next prompt or evaluation quickly, ideally with tighter pacing and less blocked time.
- Why it matters:
  - Slow feedback breaks rhythm. This product lives or dies on tight learning loops.

### ISSUE-004 - High - Tutor response is redundant and over-explains before re-asking

- Category: Content, Model quality
- Fix status: deferred
- Evidence:
  - Screenshot: `.gstack/qa-reports/screenshots/learn-training-timeout-state.png`
- Repro:
  1. Start training.
  2. Answer the first ACID question with a partially correct answer.
  3. Read the assistant reply.
- Actual:
  - The tutor first validates the answer, then explains the reasoning in detail, then restates the same conclusion, then asks a very similar follow-up again.
  - The learner gets both the answer and the next question in one turn.
- Expected:
  - The system should choose one move per turn: either probe, explain, or summarize. Not all three at once.
- Why it matters:
  - This reduces learner agency and makes the interaction feel like a verbose AI monologue instead of adaptive coaching.

### ISSUE-005 - Medium - Returning home does not offer an obvious one-click resume path

- Category: Flow, Navigation
- Fix status: deferred
- Evidence:
  - Screenshot: `.gstack/qa-reports/screenshots/home-after-learn-entry.png`
- Repro:
  1. Enter the learning page.
  2. Start training.
  3. Click the top-left back button to return home.
- Actual:
  - Home shows `当前阅读 10%`, but there is no obvious `继续学习` or `继续训练` CTA near the top of the page.
  - The user is dropped back into a dense catalog and must rediscover the path manually.
- Expected:
  - Returning learners should get a clear resume action from the home surface.
- Why it matters:
  - Resume flows are core retention mechanics. If resuming is annoying, repeat use drops.

### ISSUE-006 - Medium - Mobile turns the experience into a long raw-article scroll

- Category: Mobile UX
- Fix status: deferred
- Evidence:
  - Screenshot: `.gstack/qa-reports/screenshots/learn-mobile-baseline.png`
- Repro:
  1. Open the same learning page at mobile width (`375x812`).
- Actual:
  - The page becomes an extremely long vertical scroll with dense text blocks.
  - The training affordance is not meaningfully present in the visible viewport for most of the reading session.
- Expected:
  - Mobile should preserve a clear progression model, with visible study actions and stronger sectioning.
- Why it matters:
  - On mobile, this feels like dumping a document into the browser, not guiding a study session.

## Score breakdown

- Console: `100`
- Links: `100`
- Visual: `69`
- Functional: `77`
- UX: `62`
- Performance: `70`
- Content: `70`
- Accessibility: `85`

## PR summary

QA found 6 issues, fixed 0, health score `78 -> 78`.
