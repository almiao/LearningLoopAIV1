from app.engine.resume_decompose import (
    build_resume_decompose_prompt,
    decompose_resume,
    normalize_resume_topics,
)


def test_decompose_uses_injected_llm_and_normalizes():
    captured = {}

    def fake_complete(prompt):
        captured["prompt"] = prompt
        return {
            "topics": [
                {"topic": "Redis 缓存一致性项目里的兜底策略", "importance": "core"},
                {"topic": "Redis 缓存一致性项目里的兜底策略", "importance": "core"},
                {"topic": "接口隔离与降级设计", "importance": "secondary"},
                {"topic": "  "},
            ],
        }

    result = decompose_resume(
        resume_text="负责订单系统 Redis 缓存一致性和接口隔离。",
        role="Java 后端",
        complete_json=fake_complete,
    )

    assert [item["topic"] for item in result["topics"]] == [
        "Redis 缓存一致性项目里的兜底策略",
        "接口隔离与降级设计",
    ]
    assert result["topics"][0]["source"] == "resume-claim"
    assert "Java 后端" in captured["prompt"]
    assert "候选人声称会" in captured["prompt"]


def test_rejects_empty_resume():
    try:
        decompose_resume(resume_text="   ")
    except ValueError as exc:
        assert "resume_text is required" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_heuristic_double_extracts_claims(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    result = decompose_resume(
        resume_text="负责订单系统 Redis 缓存一致性；主导接口隔离和熔断降级。了解篮球。",
    )
    topics = [item["topic"] for item in result["topics"]]
    assert any("Redis" in topic for topic in topics)
    assert any("接口隔离" in topic for topic in topics)


def test_normalize_tolerates_bad_payload():
    assert normalize_resume_topics({"topics": ["AQS 队列唤醒链路", {"topic": "线程池拒绝策略", "importance": "weird"}]}) == [
        {"topic": "AQS 队列唤醒链路", "importance": "core", "source": "resume-claim"},
        {"topic": "线程池拒绝策略", "importance": "core", "source": "resume-claim"},
    ]


def test_prompt_contains_json_contract():
    prompt = build_resume_decompose_prompt(resume_text="负责订单系统。")
    assert "topics" in prompt and "importance" in prompt
