# tutor

## Active boundary

- Production training generation and answer evaluation run through `ai-service/` and a configured LLM provider.
- The remaining JavaScript files here only define and persist memory profile data used by the BFF.
- JavaScript session orchestration, heuristic tutor intelligence, turn policy, and local decomposition have been removed.
- If no provider is configured in production, the service should fail clearly instead of generating rule-based training content.
