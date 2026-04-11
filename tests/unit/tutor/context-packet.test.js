import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPacket } from "../../../src/tutor/context-packet.js";

function createSessionStub() {
  return {
    id: "session-1",
    mode: "target",
    source: {
      kind: "baseline-pack",
      title: "大厂 Java 后端面试包"
    },
    targetBaseline: {
      id: "bigtech-java-backend",
      title: "大厂 Java 后端面试包"
    },
    summary: {
      framing: "先围绕最核心的高频点做诊断。"
    },
    currentProbe: "MVCC 解决了什么？",
    interactionPreference: "balanced",
    engagement: {
      teachRequestCount: 1,
      skipCount: 0,
      consecutiveControlCount: 0
    },
    workspaceScope: {
      type: "domain",
      id: "database-core"
    },
    conceptStates: {
      mvcc: {
        attempts: 1,
        teachCount: 0
      }
    },
    runtimeMaps: {
      mvcc: {
        info_gain_level: "medium"
      }
    },
    memoryProfile: {
      abilityItems: {
        mvcc: {
          state: "partial",
          confidenceLevel: "medium",
          derivedPrinciple: "知道 MVCC 负责快照读，但锁边界不稳。"
        }
      }
    },
    turns: [
      {
        role: "system",
        kind: "workspace",
        content: "focus-domain:database-core"
      },
      {
        role: "tutor",
        kind: "question",
        conceptId: "mvcc",
        content: "MVCC 解决了什么？"
      },
      {
        role: "learner",
        kind: "answer",
        conceptId: "mvcc",
        content: "它提供历史快照。"
      }
    ]
  };
}

const concept = {
  id: "mvcc",
  title: "MVCC 与 Repeatable Read 边界",
  summary: "能解释 RR 下 MVCC 解决了什么、没解决什么，以及幻读边界。",
  excerpt: "面试常追问 RR 为什么还要 next-key lock。",
  misconception: "容易把 MVCC、锁和隔离级别混成一团。",
  importance: "core",
  coverage: "high",
  abilityDomainId: "database-core",
  abilityDomainTitle: "MySQL 事务、索引与日志",
  javaGuideSources: [
    {
      title: "InnoDB 对 MVCC 的实现",
      path: "docs/database/mysql/innodb-implementation-of-mvcc.md",
      url: "https://javaguide.cn/database/mysql/innodb-implementation-of-mvcc.html"
    }
  ],
  provenanceLabel: "阿里数据库面经原题"
};

test("buildContextPacket exposes stable, dynamic, and flat aliases for the AI turn engine", () => {
  const packet = buildContextPacket({
    session: createSessionStub(),
    concept,
    answer: "MVCC 让事务读历史版本。",
    burdenSignal: "normal",
    priorEvidence: [
      {
        id: "ev-prev-1",
        signal: "negative",
        answer: "只知道 MVCC 很重要。",
        explanation: "还没说清快照读。",
        timestamp: Date.now()
      }
    ]
  });

  assert.equal(packet.target.id, "bigtech-java-backend");
  assert.equal(packet.scope.current_anchor_id, "mvcc");
  assert.equal(packet.anchor.canonical_id, "mvcc");
  assert.equal(packet.memory_anchor_summary.state, "partial");
  assert.equal(packet.recent_turns.length, 2);
  assert.equal(packet.anchor_history.recentTurns.length, 2);
  assert.equal(packet.recent_evidence.length, 1);
  assert.equal(packet.draft_evidence.anchorId, "mvcc");
  assert.ok(packet.source_refs.length >= 1);
  assert.equal(packet.stop_conditions.should_discourage_more_probe, false);
});
