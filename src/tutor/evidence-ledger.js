export function createEvidenceLedger(concepts) {
  return Object.fromEntries(
    concepts.map((concept) => [
      concept.id,
      {
        conceptId: concept.id,
        entries: [],
        state: "weak",
        confidence: 0,
        reasons: []
      }
    ])
  );
}

function getConceptLedger(ledger, conceptId) {
  const conceptLedger = ledger[conceptId];
  if (!conceptLedger) {
    throw new Error(`Unknown concept: ${conceptId}`);
  }

  return conceptLedger;
}

export function appendEvidence(ledger, conceptId, evidence) {
  const conceptLedger = getConceptLedger(ledger, conceptId);
  conceptLedger.entries.push({
    ...evidence,
    timestamp: Date.now()
  });

  return conceptLedger;
}

export function summarizeLedger(ledger, concepts) {
  return concepts.map((concept) => {
    const conceptLedger = getConceptLedger(ledger, concept.id);
    return {
      conceptId: concept.id,
      title: concept.title,
      state: conceptLedger.state,
      reasons: conceptLedger.reasons,
      evidence: conceptLedger.entries.slice(-2).map((entry) => ({
        signal: entry.signal,
        explanation: entry.explanation,
        answer: entry.answer
      })),
      evidenceCount: conceptLedger.entries.length
    };
  });
}
