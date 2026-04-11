# Python AI 服务：可观测性与可测试性
**面向 AI 面试辅导产品的对话引擎工程化指南**

---

## 总原则

对话引擎不稳定，根源通常不是单一问题，而是这几层混在一起：输入不稳定、Prompt 版本不清、上下文组装不透明、模型输出不可复现、线上坏 case 没法回放、改了一版不知道变好还是变坏。

**设计目标：每一次 LLM 调用都必须留下完整"实验现场"**，能回答：

- 用了哪个 prompt / parser / rubric 版本
- 输入上下文到底长什么样
- 原始模型输出是什么（parse 之前）
- 这个 case 之后还能不能重放

---

## 一、目录结构

```
ai_service/
  app/
    core/
      config.py          # 版本号统一配置
      tracing.py         # trace_id / context var
    domain/
      interview/
        engine.py        # 状态机主逻辑
        context_builder.py
        prompts.py       # 所有 prompt 模板
        parsers.py       # 结构化输出解析
        validators.py    # schema 校验
        scoring.py
    infra/
      llm/
        client.py        # LLM 调用 + traced decorator
        snapshot.py      # debug bundle 存储
    observability/
      logger.py          # 结构化日志
      events.py          # 事件名常量
      metrics.py         # 指标上报
  tests/
    unit/                # 纯函数，不调 LLM
    integration/         # parser / schema 鲁棒性
    regression/          # golden cases 回放
    golden_cases/        # 从线上提升的黄金案例 *.jsonl
    fixtures/
  scripts/
    promote_to_golden.py # 把线上 case 升级为回归测试
    replay.py            # 按 trace_id 回放
```

---

## 二、版本号体系（最容易被忽视）

所有版本号集中在一个地方管理，每次 LLM 调用自动携带。

```python
# app/core/config.py

from pydantic_settings import BaseSettings

class VersionConfig(BaseSettings):
    # 每次改对应模块就 +1，用于日志和 debug bundle
    agent_version:          str = "1.0.0"
    prompt_version:         str = "prompt_v3"
    rubric_version:         str = "rubric_v2"
    context_builder_version:str = "ctx_v1"
    parser_version:         str = "parser_v2"
    tool_schema_version:    str = "tools_v1"

    # 模型参数
    model_name:     str   = "claude-sonnet-4-20250514"
    temperature:    float = 0.1   # eval 调用
    gen_temperature:float = 0.4   # 生成调用

versions = VersionConfig()
```

---

## 三、结构化日志（4 层）

### 3.1 上下文传递

```python
# app/core/tracing.py

import uuid
from contextvars import ContextVar

trace_id_var:   ContextVar[str] = ContextVar("trace_id",   default="unknown")
session_id_var: ContextVar[str] = ContextVar("session_id", default="unknown")
turn_var:       ContextVar[int] = ContextVar("turn",        default=0)

def new_trace() -> str:
    tid = str(uuid.uuid4())
    trace_id_var.set(tid)
    return tid
```

### 3.2 日志基础设施

```python
# app/observability/logger.py

import json, logging, time
from app.core.tracing import trace_id_var, session_id_var, turn_var
from app.core.config import versions

class StructuredLogger:
    def __init__(self, name: str):
        self._log = logging.getLogger(name)

    def _base(self) -> dict:
        return {
            "trace_id":      trace_id_var.get(),
            "session_id":    session_id_var.get(),
            "turn":          turn_var.get(),
            "agent_version": versions.agent_version,
            "prompt_version":versions.prompt_version,
            "environment":   "dev",  # 从环境变量读
            "timestamp":     time.time(),
        }

    def event(self, event_name: str, **kwargs):
        record = {**self._base(), "event": event_name, **kwargs}
        self._log.info(json.dumps(record, ensure_ascii=False))

logger = StructuredLogger("ai_service")
```

### 3.3 事件名常量

```python
# app/observability/events.py

REQUEST_STARTED          = "request_started"
CONTEXT_BUILT            = "context_built"
LLM_CALL_STARTED         = "llm_call_started"
LLM_CALL_COMPLETED       = "llm_call_completed"
LLM_CALL_FAILED          = "llm_call_failed"
PARSER_FAILED            = "parser_failed"
VALIDATION_FAILED        = "validation_failed"
FALLBACK_TRIGGERED       = "fallback_triggered"
BUSINESS_RESULT_GENERATED= "business_result_generated"
REQUEST_COMPLETED        = "request_completed"
```

### 3.4 四层日志示例

每层回答不同问题：

```
第1层 请求级  → 这次请求整体发生了什么
第2层 步骤级  → 哪一步最不稳定
第3层 LLM调用级 → 模型被怎么调用的（最重要）
第4层 业务结果级 → 从产品视角结果好不好
```

```python
# 第1层：请求入口处
logger.event(events.REQUEST_STARTED,
    user_id="u_123",
    request_type="answer_submit",
)

# 第2层：每个 step 开始/结束
logger.event(events.CONTEXT_BUILT,
    step_name="context_build",
    step_version=versions.context_builder_version,
    input_token_estimate=1240,
    latency_ms=45,
    status="success",
)

# 第3层：每次 LLM 调用（由 @traced decorator 自动打）
# 见下方 client.py

# 第4层：业务结果
logger.event(events.BUSINESS_RESULT_GENERATED,
    question_type="behavioral",
    difficulty="medium",
    followup_triggered=True,
    followup_reason="回答缺少量化结果",
    scores={"clarity": 4, "depth": 2, "structure": 3},
    parse_failed_count=0,
    fallback_used=False,
)
```

---

## 四、LLM 客户端：traced decorator

所有 LLM 调用通过统一入口，自动打第3层日志 + 保存 debug bundle。

```python
# app/infra/llm/client.py

import time, hashlib, functools, json
from anthropic import AsyncAnthropic
from app.core.config import versions
from app.core.tracing import trace_id_var, session_id_var
from app.observability.logger import logger
from app.observability import events
from app.infra.llm.snapshot import SnapshotStore

client = AsyncAnthropic()
snapshot_store = SnapshotStore()

def _hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:8]

def traced(call_type: str):
    """
    装饰器：自动记录第3层日志 + 保存失败快照
    call_type: 'eval' | 'followup' | 'next_question' | 'report'
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, messages: list, **kwargs):
            t0 = time.time()
            call_id = f"{trace_id_var.get()[:6]}_{call_type}"
            system = kwargs.get("system", "")

            logger.event(events.LLM_CALL_STARTED,
                llm_call_id=call_id,
                call_type=call_type,
                model=versions.model_name,
                prompt_version=versions.prompt_version,
                parser_version=versions.parser_version,
                system_prompt_hash=_hash(system),
                input_messages_count=len(messages),
                input_chars=sum(len(m.get("content","")) for m in messages),
            )

            try:
                result = await fn(*args, messages=messages, **kwargs)
                latency = int((time.time() - t0) * 1000)

                logger.event(events.LLM_CALL_COMPLETED,
                    llm_call_id=call_id,
                    call_type=call_type,
                    model=versions.model_name,
                    prompt_version=versions.prompt_version,
                    rubric_version=versions.rubric_version,
                    parser_version=versions.parser_version,
                    latency_ms=latency,
                    output_tokens=result.usage.output_tokens if hasattr(result, "usage") else None,
                    parse_success=result.parse_success,
                    validation_success=result.validation_success,
                    fallback_used=result.fallback_used,
                )
                return result

            except Exception as e:
                latency = int((time.time() - t0) * 1000)
                logger.event(events.LLM_CALL_FAILED,
                    llm_call_id=call_id,
                    call_type=call_type,
                    latency_ms=latency,
                    error_type=type(e).__name__,
                    error_message=str(e),
                )
                # 失败 case 100% 保存快照
                await snapshot_store.save(
                    trace_id=trace_id_var.get(),
                    call_type=call_type,
                    messages=messages,
                    raw_response=None,
                    error=str(e),
                    versions=versions.model_dump(),
                )
                raise

        return wrapper
    return decorator


@traced("eval")
async def call_eval_llm(messages: list, system: str) -> "EvalResult":
    resp = await client.messages.create(
        model=versions.model_name,
        max_tokens=512,
        temperature=versions.temperature,
        system=system,
        messages=messages,
    )
    raw = resp.content[0].text
    return parse_eval_xml(raw)


@traced("followup")
async def call_gen_llm(messages: list, system: str) -> "GenResult":
    resp = await client.messages.create(
        model=versions.model_name,
        max_tokens=1024,
        temperature=versions.gen_temperature,
        system=system,
        messages=messages,
    )
    raw = resp.content[0].text
    return GenResult(text=raw, parse_success=True, validation_success=True, fallback_used=False)
```

---

## 五、Debug Bundle（快照存储）

**区分"在线日志"和"调试快照"是最容易被忽略的设计。**

在线日志放结构化字段，便于搜索聚合；调试快照保存完整现场，用于回放。

```python
# app/infra/llm/snapshot.py

import json, time
from pathlib import Path
from app.core.tracing import trace_id_var, session_id_var, turn_var

class SnapshotStore:
    def __init__(self, base_dir: str = "snapshots"):
        self.base_dir = Path(base_dir)

    async def save(
        self,
        trace_id: str,
        call_type: str,
        messages: list,
        raw_response: str | None,
        parsed: dict | None = None,
        error: str | None = None,
        versions: dict | None = None,
        sample: bool = False,  # True = 按采样率保存成功 case
    ):
        """
        失败 case: 100% 保存
        成功 case: 由调用方决定是否 sample（如 5%）
        """
        bundle = {
            "trace_id":     trace_id,
            "session_id":   session_id_var.get(),
            "turn":         turn_var.get(),
            "call_type":    call_type,
            "saved_at":     time.time(),
            "versions":     versions or {},
            # 完整现场
            "messages":     messages,       # 实际发给模型的完整 messages
            "raw_response": raw_response,   # 模型原始输出，parse 之前
            "parsed":       parsed,         # parse 结果
            "error":        error,
        }
        path = self.base_dir / call_type / f"{trace_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2))
        return path
```

**采样策略建议：**

```python
import random

# 在 engine.py 里，成功调用后决定是否保存快照
if random.random() < 0.05:  # 5% 采样成功 case
    await snapshot_store.save(..., sample=True)

# 灰度版本 / 高价值用户提高采样率
if user.is_premium or is_canary_version:
    await snapshot_store.save(..., sample=True)  # 100%
```

---

## 六、结构化输出：先结构化，再渲染

**最重要的设计决策：让模型先输出结构化中间结果，渲染层再转成用户文案。**

这样测试能测结构，而不是测措辞。

### 6.1 Prompt 模板（版本化）

```python
# app/domain/interview/prompts.py
# prompt_version = "prompt_v3"（与 config 对应）

EVAL_SYSTEM = """
你是面试评估引擎。根据候选人的回答，输出结构化评估结果。
只输出 XML，不要任何其他内容，不要 markdown 代码块。

<evaluation>
  <completeness>1-5的整数，5=完整覆盖了问题要点</completeness>
  <depth>1-5的整数，5=有具体细节和量化数据</depth>
  <structure>1-5的整数，5=逻辑清晰有条理</structure>
  <next_action>follow_up 或 next_question 或 end_interview</next_action>
  <follow_up_reason>如果是follow_up，一句话说明追问方向</follow_up_reason>
  <missing_points>回答中缺失的关键点，逗号分隔，没有则留空</missing_points>
</evaluation>
""".strip()

FOLLOWUP_SYSTEM = """
你是专业面试官，正在进行技术面试。
根据评估结果中指出的不足，生成一个追问问题。
要求：自然、具体、与候选人上一个回答直接相关，不超过2句话。
""".strip()

def build_eval_messages(question: str, answer: str, history: list) -> list:
    """构建发给模型的完整 messages，context builder 版本化在这里体现"""
    msgs = []
    # 只保留最近 6 轮，避免 token 超限
    for h in history[-6:]:
        msgs.append({"role": "user",      "content": h["answer"]})
        msgs.append({"role": "assistant", "content": h["feedback"]})
    msgs.append({"role": "user", "content": f"问题：{question}\n\n候选人回答：{answer}"})
    return msgs
```

### 6.2 Parser + 容错

```python
# app/domain/interview/parsers.py
# parser_version = "parser_v2"

import re
from dataclasses import dataclass, field

@dataclass
class EvalResult:
    completeness:      int   = 3
    depth:             int   = 3
    structure:         int   = 3
    next_action:       str   = "follow_up"
    follow_up_reason:  str   = ""
    missing_points:    list  = field(default_factory=list)
    # 元信息，供日志使用
    raw:               str   = ""
    parse_success:     bool  = False
    validation_success:bool  = False
    fallback_used:     bool  = False

VALID_ACTIONS = {"follow_up", "next_question", "end_interview"}

def parse_eval_xml(raw: str) -> EvalResult:
    result = EvalResult(raw=raw)

    def extract(tag: str) -> str | None:
        m = re.search(rf"<{tag}>(.*?)</{tag}>", raw, re.DOTALL)
        return m.group(1).strip() if m else None

    try:
        c = extract("completeness")
        d = extract("depth")
        s = extract("structure")
        a = extract("next_action")
        r = extract("follow_up_reason")
        m = extract("missing_points")

        result.completeness = int(c) if c and c.isdigit() else 3
        result.depth        = int(d) if d and d.isdigit() else 3
        result.structure    = int(s) if s and s.isdigit() else 3
        result.follow_up_reason = r or ""
        result.missing_points   = [x.strip() for x in m.split(",")] if m else []

        # next_action 只允许合法值，非法时保守降级
        result.next_action = a if a in VALID_ACTIONS else "follow_up"
        if a not in VALID_ACTIONS:
            result.fallback_used = True

        result.parse_success = True
        result.validation_success = validate_eval(result)

    except Exception:
        result.fallback_used = True

    return result

def validate_eval(r: EvalResult) -> bool:
    return (
        1 <= r.completeness <= 5 and
        1 <= r.depth <= 5 and
        1 <= r.structure <= 5 and
        r.next_action in VALID_ACTIONS
    )
```

### 6.3 渲染层（独立于 LLM 调用）

```python
# app/domain/interview/renderer.py

def render_followup_prompt(eval_result: EvalResult, raw_followup: str) -> dict:
    """
    把结构化中间结果 + 生成文案 → 最终返回给用户的结构
    渲染层不调 LLM，纯函数，100% 可单元测试
    """
    return {
        "type":    "follow_up",
        "message": raw_followup,
        "scores": {
            "completeness": eval_result.completeness,
            "depth":        eval_result.depth,
            "structure":    eval_result.structure,
        },
        "hints": eval_result.missing_points[:2],  # 最多给用户2个提示
    }
```

---

## 七、状态机（代码决策，LLM 只输出信号）

```python
# app/domain/interview/engine.py

from app.infra.llm.client import call_eval_llm, call_gen_llm
from app.domain.interview.prompts import EVAL_SYSTEM, FOLLOWUP_SYSTEM, build_eval_messages
from app.domain.interview.renderer import render_followup_prompt
from app.core.tracing import turn_var
from app.observability.logger import logger
from app.observability import events

class InterviewEngine:
    MAX_FOLLOWUPS_PER_QUESTION = 2
    MIN_SCORE_TO_PROCEED = 3   # completeness 低于此值才追问

    def __init__(self, session_id: str, questions: list):
        self.session_id = session_id
        self.questions  = questions
        self.current_q  = 0
        self.followup_count = 0
        self.history    = []

    async def process_answer(self, answer: str) -> dict:
        turn_var.set(turn_var.get() + 1)
        question = self.questions[self.current_q]

        # 第一次调用：只做评估，输出结构化信号
        messages = build_eval_messages(question, answer, self.history)
        eval_result = await call_eval_llm(messages=messages, system=EVAL_SYSTEM)

        if not eval_result.parse_success:
            logger.event(events.PARSER_FAILED, call_type="eval")

        # 代码决定状态跳转，不依赖 LLM 文字描述
        next_action = self._decide_action(eval_result)

        if next_action == "follow_up":
            # 第二次调用：只做生成，不做判断
            gen = await call_gen_llm(messages=messages, system=FOLLOWUP_SYSTEM)
            self.followup_count += 1
            return render_followup_prompt(eval_result, gen.text)

        elif next_action == "next_question":
            self.current_q += 1
            self.followup_count = 0
            self.history.append({"answer": answer, "feedback": "", "scores": eval_result.__dict__})
            return {"type": "next_question", "question": self.questions[self.current_q]}

        else:  # end_interview
            return {"type": "end", "session_id": self.session_id}

    def _decide_action(self, eval_result) -> str:
        """
        状态转换完全由代码控制。
        LLM 的 next_action 只作为参考信号，最终由规则决定。
        """
        # 强制结束条件
        if self.current_q >= len(self.questions) - 1:
            return "end_interview"

        # 追问上限
        if self.followup_count >= self.MAX_FOLLOWUPS_PER_QUESTION:
            return "next_question"

        # 质量足够就继续
        if eval_result.completeness >= self.MIN_SCORE_TO_PROCEED:
            return "next_question"

        # LLM 建议追问 + 质量不够才追问
        if eval_result.next_action == "follow_up":
            return "follow_up"

        return "next_question"
```

---

## 八、测试体系（三层）

```
第1层 单元测试  → 纯函数，毫秒级，每次提交跑
第2层 快照测试  → Prompt 变更检测，改 Prompt 时跑
第3层 回放测试  → 黄金案例回放，每次发版前跑
```

### 8.1 单元测试：Parser + 状态机

```python
# tests/unit/test_parser.py
import pytest
from app.domain.interview.parsers import parse_eval_xml, EvalResult

class TestParseEvalXml:
    def test_正常输出(self):
        raw = """
        <evaluation>
          <completeness>4</completeness><depth>3</depth><structure>4</structure>
          <next_action>next_question</next_action>
          <follow_up_reason></follow_up_reason>
          <missing_points></missing_points>
        </evaluation>
        """
        r = parse_eval_xml(raw)
        assert r.completeness == 4
        assert r.next_action == "next_question"
        assert r.parse_success is True
        assert r.fallback_used is False

    def test_XML前有多余文字(self):
        raw = "好的，以下是评估：\n<evaluation><completeness>3</completeness><depth>2</depth><structure>3</structure><next_action>follow_up</next_action><follow_up_reason>缺少量化</follow_up_reason><missing_points></missing_points></evaluation>"
        r = parse_eval_xml(raw)
        assert r.next_action == "follow_up"
        assert r.parse_success is True

    def test_next_action非法值降级(self):
        raw = "<evaluation><completeness>3</completeness><depth>3</depth><structure>3</structure><next_action>继续提问</next_action><follow_up_reason></follow_up_reason><missing_points></missing_points></evaluation>"
        r = parse_eval_xml(raw)
        assert r.next_action == "follow_up"   # 保守降级
        assert r.fallback_used is True

    def test_分数超出范围仍能解析(self):
        raw = "<evaluation><completeness>3</completeness><depth>3</depth><structure>3</structure><next_action>next_question</next_action><follow_up_reason></follow_up_reason><missing_points></missing_points></evaluation>"
        r = parse_eval_xml(raw)
        assert r.validation_success is True

    def test_完全乱码不崩溃(self):
        r = parse_eval_xml("这不是XML格式的任何内容")
        assert r.parse_success is False
        assert r.fallback_used is True
        assert r.next_action == "follow_up"


# tests/unit/test_state_machine.py
from unittest.mock import MagicMock
from app.domain.interview.engine import InterviewEngine
from app.domain.interview.parsers import EvalResult

def make_engine(n_questions=5):
    e = InterviewEngine("sess_test", [f"Q{i}" for i in range(n_questions)])
    return e

def make_eval(completeness=4, next_action="next_question") -> EvalResult:
    return EvalResult(completeness=completeness, depth=3, structure=3,
                      next_action=next_action, parse_success=True,
                      validation_success=True, fallback_used=False)

def test_低分触发追问():
    e = make_engine()
    action = e._decide_action(make_eval(completeness=2, next_action="follow_up"))
    assert action == "follow_up"

def test_追问达上限强制进入下一题():
    e = make_engine()
    e.followup_count = 2  # 已达上限
    action = e._decide_action(make_eval(completeness=2, next_action="follow_up"))
    assert action == "next_question"

def test_最后一题强制结束():
    e = make_engine(n_questions=3)
    e.current_q = 2  # 已是最后一题
    action = e._decide_action(make_eval(completeness=2))
    assert action == "end_interview"

def test_高分直接进入下一题():
    e = make_engine()
    action = e._decide_action(make_eval(completeness=5))
    assert action == "next_question"
```

### 8.2 快照测试：Prompt 变更检测

```python
# tests/integration/test_prompt_snapshots.py
"""
首次建立基准：UPDATE_SNAPSHOTS=1 pytest tests/integration/test_prompt_snapshots.py
之后验证变更：pytest tests/integration/test_prompt_snapshots.py
"""
import os
from pathlib import Path
from app.domain.interview.prompts import build_eval_messages, EVAL_SYSTEM

SNAPSHOT_DIR = Path("tests/snapshots")

def assert_snapshot(name: str, actual: str):
    path = SNAPSHOT_DIR / f"{name}.txt"
    if os.environ.get("UPDATE_SNAPSHOTS"):
        path.parent.mkdir(exist_ok=True)
        path.write_text(actual)
        print(f"\n[快照已更新] {path}")
        return
    assert path.exists(), f"快照不存在，请先运行: UPDATE_SNAPSHOTS=1 pytest {__file__}"
    expected = path.read_text()
    assert actual == expected, (
        f"Prompt 已静默变更: {name}\n"
        f"如果是预期变更，运行: UPDATE_SNAPSHOTS=1 pytest {__file__}\n"
        f"--- 期望 ---\n{expected[:200]}\n--- 实际 ---\n{actual[:200]}"
    )

def test_eval_system_prompt_快照():
    assert_snapshot("eval_system_prompt", EVAL_SYSTEM)

def test_eval_messages_构造_快照():
    msgs = build_eval_messages(
        question="介绍你最近一个项目的架构决策",
        answer="我设计了一个微服务系统，选择了 Kubernetes 做编排",
        history=[],
    )
    import json
    assert_snapshot("eval_messages_no_history", json.dumps(msgs, ensure_ascii=False, indent=2))
```

### 8.3 回放测试：黄金案例

```python
# tests/regression/test_replay.py
"""
把线上真实 case 固化为永久回归测试。
运行：pytest tests/regression/test_replay.py
"""
import json, pytest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from app.domain.interview.parsers import parse_eval_xml

def load_golden_cases():
    cases = []
    golden_dir = Path("tests/golden_cases")
    if not golden_dir.exists():
        return cases
    for f in sorted(golden_dir.glob("*.jsonl")):
        turns = [json.loads(line) for line in f.read_text().strip().splitlines() if line.strip()]
        cases.append((f.stem, turns))
    return cases

@pytest.mark.parametrize("case_name,turns", load_golden_cases())
def test_回放黄金案例(case_name, turns):
    for turn in turns:
        # 用历史记录的 raw_response 重新 parse，验证 parser 没有退化
        raw = turn.get("raw_response", "")
        if not raw:
            continue
        result = parse_eval_xml(raw)
        expected = turn.get("parsed", {})

        assert result.next_action == expected.get("next_action"), (
            f"[{case_name}] turn {turn.get('turn')}: "
            f"期望 next_action={expected.get('next_action')}，"
            f"实际={result.next_action}\n"
            f"raw_response: {raw[:200]}"
        )
        if "completeness" in expected:
            assert result.completeness == expected["completeness"], (
                f"[{case_name}] turn {turn.get('turn')}: completeness 不一致"
            )
```

---

## 九、工具脚本

### 9.1 把线上 case 提升为黄金案例

```python
# scripts/promote_to_golden.py
"""
用法：python scripts/promote_to_golden.py snapshots/eval/trace_abc123.json "追问没有触发-低分case"
"""
import sys, json, shutil
from pathlib import Path

src_path  = Path(sys.argv[1])
case_name = sys.argv[2] if len(sys.argv) > 2 else src_path.stem
dst_dir   = Path("tests/golden_cases")
dst_dir.mkdir(exist_ok=True)

bundle = json.loads(src_path.read_text())

# 转成 JSONL 格式（每行一个 turn）
jsonl_path = dst_dir / f"{case_name}.jsonl"
with open(jsonl_path, "w") as f:
    f.write(json.dumps(bundle, ensure_ascii=False) + "\n")

print(f"已添加黄金案例: {jsonl_path}")
print(f"运行验证: pytest tests/regression/test_replay.py -k '{case_name}' -v")
```

### 9.2 按 trace_id 本地回放

```python
# scripts/replay.py
"""
用法：python scripts/replay.py trace_abc123
功能：找到该 trace 的快照，重新执行 parse，对比当前版本与快照版本的结果差异
"""
import sys, json
from pathlib import Path
from app.domain.interview.parsers import parse_eval_xml

trace_id = sys.argv[1]

# 找快照文件
candidates = list(Path("snapshots").rglob(f"{trace_id}.json"))
if not candidates:
    print(f"未找到 trace_id={trace_id} 的快照")
    sys.exit(1)

bundle = json.loads(candidates[0].read_text())
raw = bundle.get("raw_response", "")
original_parsed = bundle.get("parsed", {})

print(f"=== 回放: {trace_id} ===")
print(f"call_type:  {bundle.get('call_type')}")
print(f"版本(当时): {bundle.get('versions', {})}")
print(f"原始输出:\n{raw[:500]}")
print()

current = parse_eval_xml(raw)
print(f"=== 对比结果 ===")
print(f"next_action:  原={original_parsed.get('next_action')}  现={current.next_action}  {'✓' if original_parsed.get('next_action') == current.next_action else '✗ 不一致'}")
print(f"completeness: 原={original_parsed.get('completeness')}  现={current.completeness}")
print(f"parse_success: {current.parse_success}")
print(f"fallback_used: {current.fallback_used}")
```

---

## 十、指标体系

指标看趋势，日志看单次，两者缺一不可。

```python
# app/observability/metrics.py
# 使用 Prometheus client，或者简化版直接写到日志聚合

from prometheus_client import Counter, Histogram, Gauge

# 稳定性指标
request_total       = Counter("interview_requests_total", "总请求数", ["status"])
parse_success_total = Counter("parse_success_total",      "解析成功数", ["call_type"])
parse_failed_total  = Counter("parse_failed_total",       "解析失败数", ["call_type"])
fallback_total      = Counter("fallback_triggered_total", "fallback触发数", ["reason"])
validation_failed   = Counter("validation_failed_total",  "校验失败数", ["call_type"])

# 性能指标
llm_latency = Histogram("llm_latency_ms", "LLM调用延迟", ["call_type"],
                         buckets=[200,500,800,1200,2000,3000,5000])
first_token_latency = Histogram("first_token_latency_ms", "首token延迟", ["call_type"])

# 质量代理指标（无需人工标注，自动收集）
followup_rate        = Gauge("followup_trigger_rate",   "追问触发率")
avg_completeness     = Gauge("avg_completeness_score",  "平均完整性分")
user_dropout_rate    = Gauge("user_dropout_rate",       "用户中途退出率")
```

**最关键的 4 个指标，MVP 阶段必须有：**

```
1. parse_success_rate  = parse成功数 / 总LLM调用数   → 低于 95% 要告警
2. fallback_rate       = fallback触发数 / 总请求数    → 追踪模型输出质量
3. p95_llm_latency     = LLM调用 p95 延迟             → 用户体验底线
4. followup_rate       = 追问触发数 / 总回答数         → 引擎行为是否符合预期
```

---

## 十一、迭代闭环

把以上串起来，日常改 Prompt 的完整流程：

```
1. 发现线上坏 case
   → 从结构化日志拿 trace_id

2. 拿到快照
   → snapshots/eval/{trace_id}.json
   → 包含完整 messages、raw_response、versions

3. 本地回放，先看到红
   → python scripts/replay.py {trace_id}

4. 修改 Prompt 或 Parser
   → 编辑 prompts.py 或 parsers.py
   → 更新 config.py 中对应版本号

5. 更新快照基准（如果改了 Prompt）
   → UPDATE_SNAPSHOTS=1 pytest tests/integration/test_prompt_snapshots.py

6. 全套测试变绿
   → pytest tests/

7. 固化为黄金案例
   → python scripts/promote_to_golden.py snapshots/eval/{trace_id}.json "case描述"

8. 小流量上线（1%～5%）
   → 观察 parse_success_rate / fallback_rate / latency 指标

9. 指标稳定后全量
```

整个循环不需要手动点击产品，本地 5 分钟内完成一次迭代。

---

## 十二、实施优先级

按此顺序落地，每步独立可验收：

| 优先级 | 任务 | 收益 |
|--------|------|------|
| P0 | 给每次请求加 `trace_id`，打结构化日志 | 问题可定位 |
| P0 | 版本号体系（prompt/parser/rubric） | 变更可追溯 |
| P0 | 失败 case 全量保存 debug bundle | 问题可复现 |
| P0 | Parser 容错 + schema 校验 | 消除解析层不稳定 |
| P1 | 20～50 个 golden cases + 回放测试 | 改动有回归保护 |
| P1 | Prompt 快照测试 | 静默变更可检测 |
| P1 | 4 个核心指标面板 | 趋势可量化 |
| P2 | replay CLI 脚本 | 本地复现提速 |
| P2 | 成功 case 5% 采样快照 | 扩大样本积累 |
| P3 | 小流量灰度 + shadow 对比 | 安全上线新版本 |
