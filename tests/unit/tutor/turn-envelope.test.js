import test from "node:test";
import assert from "node:assert/strict";
import {
  assertConsistentTurnEnvelope,
  assertValidTurnEnvelope,
  buildControlVerdict,
  mergeRuntimeMaps,
  turnEnvelopeToTutorMove
} from "../../../src/tutor/turn-envelope.js";

function createEnvelope(overrides = {}) {
  return {
    runtime_map: {
      anchor_id: "mvcc",
      turn_signal: "positive",
      anchor_assessment: {
        state: "partial",
        confidence_level: "medium",
        reasons: ["已经知道 MVCC 跟快照读有关。"]
      },
      hypotheses: [],
      misunderstandings: [],
      open_questions: ["为什么当前读还需要锁"],
      verification_targets: [],
      info_gain_level: "medium",
      ...overrides.runtime_map
    },
    next_move: {
      intent: "继续确认当前读和锁边界。",
      reason: "用户已经摸到主干，可以再做一次验证。",
      expected_gain: "medium",
      ui_mode: "verify",
      ...overrides.next_move
    },
    reply: {
      visible_reply: "你已经碰到关键点了，不过还要把当前读和锁边界带上。",
      teaching_paragraphs: [],
      evidence_reference: "RR 为什么还要 next-key lock。",
      next_prompt: "那你继续说说，为什么 RR 有 MVCC 以后当前读还是要 next-key lock？",
      takeaway: "MVCC 主要管快照读，当前读边界还要看锁。",
      confirmed_understanding: "你已经知道 MVCC 处理历史快照。",
      remaining_gap: "还没把当前读和锁边界讲清楚。",
      revisit_reason: "",
      requires_response: true,
      complete_current_unit: false,
      ...overrides.reply
    },
    writeback_suggestion: {
      should_write: true,
      mode: "update",
      reason: "new_high_value_partial_signal",
      anchor_patch: {
        state: "partial",
        confidence_level: "medium",
        derived_principle: "知道 MVCC 管快照读，但锁边界不稳。"
      },
      ...overrides.writeback_suggestion
    }
  };
}

test("valid positive verify envelopes map to deepen tutor moves for compatibility", () => {
  const envelope = createEnvelope();
  assertValidTurnEnvelope(envelope, "mvcc");
  assertConsistentTurnEnvelope(envelope, {
    stop_conditions: {
      should_discourage_more_probe: false
    }
  });

  const tutorMove = turnEnvelopeToTutorMove(envelope, {
    id: "mvcc",
    summary: "MVCC 概念总结",
    excerpt: "MVCC 证据"
  });

  assert.equal(tutorMove.moveType, "deepen");
  assert.equal(tutorMove.judge.state, "partial");
  assert.equal(tutorMove.nextQuestion, envelope.reply.next_prompt);
});

test("inconsistent negligible-gain probe envelopes are rejected", () => {
  const envelope = createEnvelope({
    runtime_map: {
      info_gain_level: "negligible",
      turn_signal: "negative"
    },
    next_move: {
      ui_mode: "probe"
    }
  });

  assert.throws(
    () =>
      assertConsistentTurnEnvelope(envelope, {
        stop_conditions: {
          should_discourage_more_probe: false
        }
      }),
    /negligible info gain/
  );
});

test("mergeRuntimeMaps preserves prior supported hypotheses unless newly refuted", () => {
  const merged = mergeRuntimeMaps(
    {
      anchor_id: "mvcc",
      turn_signal: "negative",
      anchor_assessment: {
        state: "partial",
        confidence_level: "medium",
        reasons: ["已有判断"]
      },
      hypotheses: [
        {
          id: "knows_snapshot",
          status: "supported",
          confidence_level: "medium",
          evidence_refs: ["ev-1"],
          note: "知道 MVCC 解决快照读。"
        }
      ],
      misunderstandings: [],
      open_questions: ["为什么当前读还要锁"],
      verification_targets: [],
      info_gain_level: "medium"
    },
    {
      anchor_id: "mvcc",
      turn_signal: "positive",
      anchor_assessment: {
        state: "partial",
        confidence_level: "high",
        reasons: ["新证据更强"]
      },
      hypotheses: [
        {
          id: "knows_lock_boundary",
          status: "supported",
          confidence_level: "medium",
          evidence_refs: ["ev-2"],
          note: "知道当前读边界还要锁。"
        }
      ],
      misunderstandings: [],
      open_questions: [],
      verification_targets: [],
      info_gain_level: "low"
    },
    "mvcc"
  );

  assert.equal(merged.hypotheses.length, 2);
  assert.ok(merged.hypotheses.some((item) => item.id === "knows_snapshot"));
  assert.ok(merged.hypotheses.some((item) => item.id === "knows_lock_boundary"));
});

test("buildControlVerdict emits explicit control-layer stop reasoning", () => {
  const verdict = buildControlVerdict({
    envelope: createEnvelope({
      next_move: {
        ui_mode: "advance"
      },
      reply: {
        requires_response: false
      }
    }),
    contextPacket: {
      stop_conditions: {
        should_discourage_more_probe: false
      },
      budget: {
        remaining_probe_turns: 0,
        remaining_teach_turns: 1
      }
    },
    scopeType: "domain"
  });

  assert.equal(verdict.should_stop, true);
  assert.equal(verdict.reason, "next_move_requests_stop");
  assert.equal(verdict.scope_type, "domain");
});
