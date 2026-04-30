# tutor

Shared tutor state and compatibility modules.

## Active boundary

- Production training generation and answer evaluation run through `ai-service/` and a configured LLM provider.
- Deterministic JS modules here may still own state projection, memory writeback, progress-adjacent helpers, and regression tests.
- `tutor-intelligence.js` heuristic behavior is a test double only. It must not become a silent runtime fallback.
- If no provider is configured in production, the service should fail clearly instead of generating rule-based training content.
