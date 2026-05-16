# QA Report — PDF Sample Flow

Date: 2026-05-07
Target: `http://127.0.0.1:3000`
Sample file: `/Users/lee/Downloads/唐乐_高级Java.pdf`
Mode: Standard baseline only
Status: DONE_WITH_CONCERNS

## Scope

This QA pass focused on one concrete sample flow:

1. Import a local PDF
2. Open the imported material in the reader
3. Check original PDF view
4. Check learning-text extraction
5. Check ask-the-document behavior
6. Check training start behavior

Because the working tree is dirty, this pass did not apply source-code fixes or create QA commits.

## What Worked

### Import

- Upload via `POST /api/materials/upload` succeeded for `唐乐_高级Java.pdf`
- Material created:
  - path: `materials/f49a069e-9069-4c7a-ac47-e7349dcab61a`
  - title: `唐乐_高级Java`
  - `primaryFormat: "pdf"`
- Backend extraction completed:
  - `learning.extractionStatus: "ready"`
  - `learning.sufficientForQa: true`
  - `learning.sufficientForTraining: true`

### Reader entry

- Imported PDF appears in the materials category for the QA account
- Clicking the document from the homepage opens the reader successfully
- Reader shows:
  - title
  - original/learning toggle
  - outline panel
  - ask-the-document panel

### Original PDF surface

- Reader renders a PDF container with an inline original-file link
- DOM confirms a PDF iframe surface and the correct `打开原文` URL

### Learning extraction

- Learning text is non-empty and includes the resume body
- Reader builds an outline from extracted text

## Findings

### ISSUE-001 — Ask-the-document summary does not resolve on this PDF sample

Severity: High
Category: Functional

What happened:

- On the PDF reader page, clicking `总结全文` accepted the action
- The assistant panel moved into a pending state
- After waiting, the UI remained in `正在生成回复...`
- No answer content was rendered in the panel during the test window

Why it matters:

- Users can trigger a document question, but the UI does not deliver a usable result
- From the user's perspective this feels like a broken feature, not a slow feature

Observed evidence:

- The assistant panel changed from idle into a pending state
- Buttons became disabled
- The expected answer never appeared during the verification wait

Notes:

- This may be a frontend state propagation problem, a long-running answer path, or a sample-specific downstream failure
- It needs a targeted repro against the same sample with network/log tracing

### ISSUE-002 — Training start enters preparing state and does not surface the first probe in the UI

Severity: High
Category: Functional

What happened:

- Clicking `开始训练` was accepted
- The right panel switched into training mode
- The UI showed `正在准备训练，会先拆解这篇文档的训练点。`
- Even after additional wait, the UI did not surface the first training question in the tested session

Why it matters:

- Users can enter training mode, but do not get the first actionable prompt
- This blocks the core value of the imported document flow

Important isolation result:

- Direct backend call to `POST /api/interview/start-target` for the same sample returned successfully in about `0.01s`
- The API returned:
  - a valid `sessionId`
  - `currentProbe: true`
  - `trainingPoints: 6`

Interpretation:

- Backend training decomposition/start is working for this sample
- The likely fault is on the frontend transition from "starting training" to "show first probe"

### ISSUE-003 — PDF-derived outline quality is weak for resume-style documents

Severity: Medium
Category: UX / Content

What happened:

- The outline for this PDF sample includes entries such as:
  - `13540886013 1289790807@qq.com 北京`
  - `在职 北京 高级Java`
  - full sentence fragments

Why it matters:

- The outline panel becomes noisy and low-signal
- Users lose trust in the "知识目录" as a navigation aid
- This is especially noticeable for PDFs without strong heading structure

Interpretation:

- Current outline heuristics are too eager for unstructured PDF text
- For resume-like PDFs, the system should either:
  - suppress weak headings, or
  - fall back to a minimal outline

## Health Summary

Before fixes:

- Import: Healthy
- Reader entry: Healthy
- Original PDF render surface: Healthy
- Learning extraction: Usable with caveats
- Ask-the-document: Broken on tested sample
- Training UI handoff: Broken on tested sample
- Outline quality: Weak on tested sample

Overall sample health: 63/100

## Top 3 Things To Fix

1. Fix the training UI handoff so `开始训练` reliably shows the first probe after `start-target` succeeds.
2. Fix the ask-the-document pending state so `总结全文` resolves or fails explicitly instead of hanging.
3. Tighten PDF outline heuristics so low-signal lines do not become headings.

## Recommended Next Step

Run a focused fix pass on:

- [learn-workspace.js](/Users/lee/IdeaProjects/LearningLoopAIV1/frontend/components/learn-workspace.js:1)
- [bff/src/server.js](/Users/lee/IdeaProjects/LearningLoopAIV1/bff/src/server.js:1)
- training session handoff / answer request path

Then re-run the same sample with:

- `唐乐_高级Java.pdf`
- one summary action
- one fresh training start
