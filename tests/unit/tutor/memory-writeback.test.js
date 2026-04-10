import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryProfile } from "../../../src/tutor/capability-memory.js";
import { applyWritebackSuggestion } from "../../../src/tutor/memory-writeback.js";

const concept = {
  id: "mvcc",
  title: "MVCC 与 Repeatable Read 边界",
  abilityDomainId: "database-core",
  abilityDomainTitle: "MySQL 事务、索引与日志",
  remediationMaterials: [],
  summary: "能解释 RR 下 MVCC 解决了什么、没解决什么，以及幻读边界。"
};

test("applyWritebackSuggestion stores derived principle and evidence snapshots", () => {
  const profile = createMemoryProfile("profile-1");

  const result = applyWritebackSuggestion(profile, {
    concept,
    suggestion: {
      should_write: true,
      mode: "update",
      reason: "new_high_value_positive_evidence",
      anchor_patch: {
        state: "partial",
        confidence_level: "medium",
        derived_principle: "知道 MVCC 管快照读，但当前读边界还不稳。"
      }
    },
    evidencePoint: {
      answer: "MVCC 解决快照读一致性，但当前读还要锁。",
      prompt: "MVCC 解决了什么？",
      sourceRefs: ["InnoDB 对 MVCC 的实现"],
      assessmentHandle: "baseline:mvcc:1"
    },
    explanation: "你已经抓到主干了，但要补 current read 边界。",
    runtimeMap: {
      turn_signal: "positive",
      anchor_assessment: {
        reasons: ["已经能把快照读和锁边界分开讲。"]
      }
    }
  });

  assert.equal(result.applied, true);
  assert.equal(profile.abilityItems.mvcc.confidenceLevel, "medium");
  assert.equal(
    profile.abilityItems.mvcc.derivedPrinciple,
    "知道 MVCC 管快照读，但当前读边界还不稳。"
  );
  assert.equal(profile.abilityItems.mvcc.evidence.length, 1);
  assert.deepEqual(profile.abilityItems.mvcc.projectedTargets, []);
  assert.equal(profile.abilityItems.mvcc.recentStrongEvidence.length, 1);
});

test("applyWritebackSuggestion carries projected targets and conflicting snapshots", () => {
  const profile = createMemoryProfile("profile-3");
  profile.abilityItems.mvcc = {
    abilityItemId: "mvcc",
    title: concept.title,
    abilityDomainId: concept.abilityDomainId,
    abilityDomainTitle: concept.abilityDomainTitle,
    state: "solid",
    confidence: 0.86,
    confidenceLevel: "high",
    reasons: ["旧证据认为已掌握"],
    derivedPrinciple: "旧结论",
    evidenceCount: 1,
    evidence: [],
    recentStrongEvidence: [],
    recentConflictingEvidence: [],
    conflictingEvidence: [],
    lastUpdatedAt: new Date().toISOString(),
    lastAssessmentHandle: "baseline:mvcc:0",
    remediationMaterials: [],
    questionFamily: "",
    provenanceLabel: "",
    sourceFamilies: [],
    projectedTargets: ["old-target"]
  };

  const result = applyWritebackSuggestion(profile, {
    concept,
    suggestion: {
      should_write: true,
      mode: "append_conflict",
      reason: "conflicting_signal_against_previous_memory",
      anchor_patch: {
        state: "partial",
        confidence_level: "medium",
        derived_principle: "新证据显示锁边界还不稳。"
      }
    },
    evidencePoint: {
      answer: "只知道 MVCC 跟快照读有关。",
      prompt: "MVCC 解决了什么？",
      sourceRefs: ["InnoDB 对 MVCC 的实现"],
      assessmentHandle: "baseline:mvcc:2"
    },
    explanation: "还没讲清当前读边界。",
    runtimeMap: {
      turn_signal: "negative",
      anchor_assessment: {
        reasons: ["对锁边界理解回落"]
      }
    },
    projectedTargets: ["bigtech-java-backend"]
  });

  assert.equal(result.applied, true);
  assert.deepEqual(profile.abilityItems.mvcc.projectedTargets.sort(), ["bigtech-java-backend", "old-target"]);
  assert.equal(profile.abilityItems.mvcc.recentConflictingEvidence.length, 1);
  assert.equal(profile.abilityItems.mvcc.conflictingEvidence.length, 1);
});

test("applyWritebackSuggestion rejects low-value evidence without source refs", () => {
  const profile = createMemoryProfile("profile-2");

  const result = applyWritebackSuggestion(profile, {
    concept,
    suggestion: {
      should_write: true,
      mode: "update",
      reason: "new_high_value_positive_evidence",
      anchor_patch: {
        state: "partial",
        confidence_level: "medium",
        derived_principle: "placeholder"
      }
    },
    evidencePoint: {
      answer: "随便答一下",
      prompt: "MVCC 解决了什么？",
      sourceRefs: []
    },
    explanation: "不够稳定"
  });

  assert.equal(result.applied, false);
  assert.equal(profile.abilityItems.mvcc, undefined);
});
