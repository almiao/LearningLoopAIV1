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

## How to add a new baseline entry

1. Modify the prompt or swap models.
2. Run `python3 evals/run_anchor_judge_eval.py` from `ai-service/`.
3. Append a dated section above with the run summary and any new cases added.
4. If `false_pass_rate` rises above 10% or `false_fail_rate` above 20%, that
   is a calibration regression — fix before shipping.
