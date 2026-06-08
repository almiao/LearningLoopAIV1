# Anchor-judge eval baseline

This file records calibration runs of `evals/run_anchor_judge_eval.py` so
regressions are visible when prompts or models change.

## 2026-06-08 · initial baseline

- **Model:** DeepSeek (via `LLAI_DEEPSEEK_API_KEY`)
- **Prompt:** `app.engine.anchor_judge.build_anchor_judge_prompt` (initial draft)
- **Result:** 12/12 cases correct. Calibration within all targets.
  - `false_pass`: 0/8 (target ≤ 10%) — none of the 5 lenient-trap cases (empty / cliché / off-topic / fabricated / name-drops) leaked through
  - `false_fail`: 0/4 (target ≤ 20%)
  - `low_confidence`: 1/12 (target ≤ 30%) — `partial_with_hedging` correctly flagged itself uncertain
  - `miss_recall_failed`: 0
- **Caveats:**
  - 12 cases ≠ statistical conclusion. Treat as smoke + direction, not proof.
  - Cases are author-written; lenient traps may be too obvious vs. real user noise.
  - DeepSeek-specific; OpenAI / Anthropic not yet measured.
  - Real users will produce noisier, more ambiguous answers than this set.
- **Interpretation:** the §0.1 design (anchor-constrained judging + "any miss → fail"
  + "low confidence → fail") works as intended against this set. The earlier
  worst-case framing of "open-ended LLM judging is unreliable so the whole
  ledger story is sand" was over-broad: anchor-constrained judging behaves
  meaningfully better than naive holistic scoring.

## 2026-06-09 · expansion to 24 cases + harness fixes

- **Model:** DeepSeek (unchanged)
- **Cases:** 24 (was 12). Added: half-truth+hallucination, markdown-formatted cliché,
  English-question pass, short-but-substance algorithm, near-miss TCP, right-question-wrong-focus
  (BatchNorm WHY vs HOW), hedged-correct (Go GMP), verbose chatty-correct (React reconciliation),
  mixed-language pass (hash table), wrong-question-addressed, vague-but-voluminous (CAP),
  missing-one-critical-anchor (volatile).
- **Result run 1:** 22/24 pass + 1 mismatch + 1 transient JSON parse error.
  - The mismatch (`near_miss_one_anchor`) was **my labeling that was wrong, not the judge**:
    I'd labeled TCP three-way handshake answer as pass because it touched the synchronization
    point; the judge correctly flagged that the textbook reason (preventing delayed/stale SYN
    segments) was missed. Flipped to expected_verdict=fail and recategorized as miss_detection.
    The eval surfaced my own prior bias.
- **Result run 2:** 23/24, CALIBRATION within targets.
  - `false_pass = 0/14 = 0%` (≤ 10% target)
  - `false_fail = 1/10 = 10%` (≤ 20% target)
  - `low_confidence = 1/24 = 4%` (≤ 30% target)
  - The 1 false_fail (`transfer_question`) was different from run 1 — that case PASSED in run 1
    (conf 1.00) and FAILED in run 2 (conf 0.60), demonstrating real run-to-run variance in LLM
    judgments at boundary cases. This is exactly what the eval is meant to surface.
- **Harness bugs fixed:**
  - The `using_heuristic` label disagreed with the actual code path (mock vs real). Now matches
    `_allow_mock()` exactly, and refuses to run with no key + no mock flag (exit 2).
  - Reported "within targets" even when all cases errored. Now invalid if any case errors;
    exit code 2 instead of 0.
- **Tooling:** `npm run eval:judge` wraps it cleanly. Loads `.env.local`, exits 0 / 1 / 2 per
  calibration result.
- **Caveats (unchanged + new):**
  - DeepSeek-specific. OpenAI / Anthropic not yet measured.
  - LLM judging has run-to-run variance at boundary cases (~4-10% flake rate on this set).
    Eval as regression gate is fine, but a single flaky case shouldn't trigger code changes —
    look for systematic drift across multiple runs.
  - 24 cases ≠ statistical conclusion. Treat as guard rail, not certification.

## How to add a new baseline entry

1. Modify the prompt or swap models.
2. Run `python3 evals/run_anchor_judge_eval.py` from `ai-service/`.
3. Append a dated section above with the run summary and any new cases added.
4. If `false_pass_rate` rises above 10% or `false_fail_rate` above 20%, that
   is a calibration regression — fix before shipping.
