from app.engine.anchor_judge import (
    build_anchor_judge_prompt,
    judge_anchors,
    normalize_anchor_judgment,
)


def test_pass_requires_model_pass_no_misses_and_confidence():
    judgment = normalize_anchor_judgment({
        "verdict": "pass",
        "confidence": 0.8,
        "anchors": [{"point": "核心机制", "hit": True}, {"point": "取舍", "hit": True}],
    })
    assert judgment["verdict"] == "pass"
    assert judgment["misses"] == []
    assert judgment["hits"] == ["核心机制", "取舍"]
    assert judgment["lowConfidence"] is False


def test_any_miss_forces_fail_even_if_model_says_pass():
    judgment = normalize_anchor_judgment({
        "verdict": "pass",
        "confidence": 0.9,
        "anchors": [{"point": "核心机制", "hit": True}, {"point": "边界处理", "hit": False}],
    })
    # §0.1 防判太松：漏了点就不能算过线。
    assert judgment["verdict"] == "fail"
    assert judgment["misses"] == ["边界处理"]


def test_low_confidence_forces_fail_and_flags_uncertain():
    judgment = normalize_anchor_judgment({
        "verdict": "pass",
        "confidence": 0.3,
        "anchors": [{"point": "核心机制", "hit": True}],
    })
    assert judgment["lowConfidence"] is True
    assert judgment["verdict"] == "fail"


def test_confidence_is_clamped_and_garbage_tolerated():
    judgment = normalize_anchor_judgment({"verdict": "pass", "confidence": "oops", "anchors": "nope"})
    assert judgment["confidence"] == 0.0
    assert judgment["anchors"] == []
    assert judgment["verdict"] == "fail"


def test_judge_anchors_with_injected_complete_json():
    captured = {}

    def fake_complete(prompt):
        captured["prompt"] = prompt
        return {
            "verdict": "fail",
            "confidence": 0.7,
            "anchors": [
                {"point": "推理/行动交替", "hit": True},
                {"point": "行动失败时的回退依据", "hit": False},
            ],
        }

    judgment = judge_anchors(
        question="ReAct 某步行动失败时靠什么决定回退？",
        answer="就是边想边做，推理和行动轮流来。",
        source_excerpt="reasoning and acting are interleaved",
        complete_json=fake_complete,
    )
    assert judgment["verdict"] == "fail"
    assert judgment["misses"] == ["行动失败时的回退依据"]
    assert judgment["hits"] == ["推理/行动交替"]
    # prompt 必须带上题目与回答
    assert "ReAct" in captured["prompt"]
    assert "边想边做" in captured["prompt"]
    assert "原文片段" in captured["prompt"]


def test_heuristic_double_used_in_test_env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    short = judge_anchors(question="讲讲 ReAct", answer="不知道")
    assert short["verdict"] == "fail"
    assert short["misses"], "short answer should miss anchors"

    long_answer = (
        "ReAct 让模型交替进行推理和行动：先推理出下一步计划，再调用工具执行，"
        "把 observation 回灌后继续，失败时根据 observation 调整或回退。"
    )
    good = judge_anchors(question="讲讲 ReAct", answer=long_answer)
    assert good["verdict"] == "pass"


def test_prompt_contains_json_contract():
    prompt = build_anchor_judge_prompt(question="Q", answer="A")
    assert "anchors" in prompt and "verdict" in prompt and "confidence" in prompt
