"""Anchor-judge calibration eval.

Run from repo root:  cd ai-service && python3 evals/run_anchor_judge_eval.py

Goal: quantify the §0.1 risk that judging is too lenient or too strict.
We don't grade absolute correctness; we measure the *bias direction* and
its rate so we can decide whether to keep iterating on the prompt or whether
the whole ledger story rests on sand.

Without an LLM key (or with APP_ENV=test) the heuristic double runs — useful
as a smoke test of the harness itself, NOT as a real measurement.
"""
from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

# Make 'app' importable when running this file directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.anchor_judge import judge_anchors  # noqa: E402

CASES_PATH = Path(__file__).resolve().parent / "anchor_judge_cases.json"


def run() -> int:
    with CASES_PATH.open(encoding="utf-8") as fh:
        bundle = json.load(fh)
    cases = bundle["cases"]
    targets = bundle["_meta"]["calibration_targets"]

    # Match anchor_judge's own _allow_mock() — that's the actual switch.
    using_heuristic = (
        os.environ.get("APP_ENV") == "test"
        or os.environ.get("LLAI_ENABLE_AI_SERVICE_HEURISTIC_TEST_DOUBLE") == "1"
    )
    has_key = bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("LLAI_DEEPSEEK_API_KEY"))
    if not using_heuristic and not has_key:
        print("\nERROR: real-LLM mode requested but no API key in env.")
        print("Set OPENAI_API_KEY or LLAI_DEEPSEEK_API_KEY, or APP_ENV=test for the heuristic double.")
        return 2
    mode = "heuristic-double (smoke test only — NOT a real measurement)" if using_heuristic else "real LLM"
    print(f"\n=== anchor_judge eval · {mode} ===\n")

    results = []
    cat_counter = Counter()
    cat_correct = Counter()

    for case in cases:
        try:
            judgment = judge_anchors(question=case["question"], answer=case["answer"])
        except Exception as exc:  # noqa: BLE001
            print(f"  [ERR] {case['id']}: {exc}")
            results.append({**case, "verdict": "error", "ok": False, "low_confidence": False})
            continue

        ok = judgment["verdict"] == case["expected_verdict"]
        cat_counter[case["category"]] += 1
        if ok:
            cat_correct[case["category"]] += 1

        miss_recall_ok = True
        expected_misses = case.get("expected_misses_include") or []
        if expected_misses and case["expected_verdict"] == "fail":
            joined = " ".join(judgment["misses"])
            miss_recall_ok = all(kw in joined for kw in expected_misses)

        results.append({
            **case,
            "verdict": judgment["verdict"],
            "ok": ok,
            "low_confidence": judgment["lowConfidence"],
            "confidence": judgment["confidence"],
            "hits": judgment["hits"],
            "misses": judgment["misses"],
            "miss_recall_ok": miss_recall_ok,
        })

        mark = "✓" if ok else "✗"
        conf_flag = " [low-conf]" if judgment["lowConfidence"] else ""
        print(f"  {mark} {case['id']:<24} expect={case['expected_verdict']:<4} got={judgment['verdict']:<4} conf={judgment['confidence']:.2f}{conf_flag}")
        if not ok:
            print(f"      misses: {judgment['misses']}")

    # Aggregate the bias direction — this is the actual point of the eval.
    n = len(results)
    errored = sum(1 for r in results if r.get("verdict") == "error")
    false_pass = sum(1 for r in results if r["expected_verdict"] == "fail" and r["verdict"] == "pass")
    false_fail = sum(1 for r in results if r["expected_verdict"] == "pass" and r["verdict"] == "fail")
    low_conf = sum(1 for r in results if r["low_confidence"])
    miss_recall_fail = sum(1 for r in results if not r.get("miss_recall_ok"))

    fail_total = sum(1 for r in results if r["expected_verdict"] == "fail")
    pass_total = sum(1 for r in results if r["expected_verdict"] == "pass")

    fp_rate = false_pass / fail_total if fail_total else 0.0
    ff_rate = false_fail / pass_total if pass_total else 0.0
    lc_rate = low_conf / n if n else 0.0

    print("\n--- summary ---")
    print(f"  cases:               {n}")
    if errored:
        print(f"  errored:             {errored}  ← UPSTREAM FAILURE, results below are not measurements")
    print(f"  false_pass:          {false_pass}/{fail_total}  rate={fp_rate:.0%}  (target ≤ {targets['false_pass_rate_max']:.0%})")
    print(f"  false_fail:          {false_fail}/{pass_total}  rate={ff_rate:.0%}  (target ≤ {targets['false_fail_rate_max']:.0%})")
    print(f"  low_confidence:      {low_conf}/{n}  rate={lc_rate:.0%}  (target ≤ {targets['low_confidence_rate_max']:.0%})")
    print(f"  miss_recall_failed:  {miss_recall_fail}")

    print("\n--- by category ---")
    for cat in sorted(cat_counter):
        print(f"  {cat:<18} {cat_correct[cat]}/{cat_counter[cat]}")

    # Calibration verdict
    breached = []
    if fp_rate > targets["false_pass_rate_max"]:
        breached.append(f"false_pass {fp_rate:.0%} > {targets['false_pass_rate_max']:.0%} (LENIENT — the §0.1 disaster)")
    if ff_rate > targets["false_fail_rate_max"]:
        breached.append(f"false_fail {ff_rate:.0%} > {targets['false_fail_rate_max']:.0%} (OVERSTRICT — punishes substance)")
    if lc_rate > targets["low_confidence_rate_max"]:
        breached.append(f"low_confidence {lc_rate:.0%} > {targets['low_confidence_rate_max']:.0%} (judge bails too often)")

    print()
    if errored:
        print("CALIBRATION: INVALID — upstream errors prevented measurement.")
        print(f"  {errored}/{n} cases errored. Fix the LLM path and re-run before trusting any rates above.")
        return 2
    if breached:
        print("CALIBRATION: FAIL")
        for b in breached:
            print(f"  - {b}")
        return 1
    print("CALIBRATION: within targets")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
