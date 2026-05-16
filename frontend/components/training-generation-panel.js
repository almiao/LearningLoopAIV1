import { renderWhitelistedMarkdownContent } from "../lib/render-markdown-content";

function buildSkeletonRows() {
  return [
    { className: "title", width: "38%" },
    { className: "body", width: "100%" },
    { className: "body", width: "94%" },
    { className: "body", width: "82%" },
    { className: "quote", width: "52%" },
    { className: "tail", width: "68%" },
  ];
}

export function TrainingGenerationPanel({
  tldr = "",
  markdown = "",
  streamingText = "",
  supplementMarkdown = "",
  complete = false,
  disconnected = false,
  error = "",
  slow = false,
  onRetry = null,
  onSkip = null,
  testId = "",
  label = "",
  statusDetail = "",
  embedded = false,
  tldrPlacement = "before",
  peerSections = false,
}) {
  const trimmedTldr = String(tldr || "").trim();
  const trimmedMarkdown = String(markdown || streamingText || "").trim();
  const trimmedSupplementMarkdown = String(supplementMarkdown || "").trim();
  const isStreaming = Boolean(trimmedMarkdown || trimmedTldr || trimmedSupplementMarkdown);
  const tldrComplete = Boolean(trimmedTldr && trimmedMarkdown);
  const tldrBlock = trimmedTldr ? (
    <aside className={`ll-training-generation-tldr${tldrComplete ? " complete" : ""}${peerSections ? " peer" : ""}`}>
      {!peerSections ? <span>AI 提炼一句</span> : null}
      <p>{trimmedTldr}</p>
    </aside>
  ) : null;
  const markdownBlock = trimmedMarkdown ? (
    <div className="ll-training-generation-stream-body markdown-content ll-whitelisted-markdown">
      {renderWhitelistedMarkdownContent(trimmedMarkdown, "training-streaming-explanation")}
    </div>
  ) : !trimmedTldr ? (
    <div className="ll-training-generation-skeleton" aria-hidden="true">
      {buildSkeletonRows().map((row) => (
        <span
          key={`${row.className}:${row.width}`}
          className={`ll-skeleton-row ${row.className}`}
          style={{ width: row.width }}
        />
      ))}
    </div>
  ) : null;
  const shouldAppendTldr = tldrPlacement === "after";
  const statusLabel = label || (
    disconnected
      ? "等待重连"
      : slow
        ? "生成慢了..."
        : complete
          ? "参考讲解"
          : "正在为你准备讲解 · 通常 3–5 秒"
  );
  const testProps = testId ? { "data-testid": testId } : {};
  const className = embedded
    ? `ll-training-generation-card embedded${isStreaming ? " streaming" : ""}`
    : `ll-training-card ll-training-generation-card${isStreaming ? " streaming" : ""}`;

  if (peerSections) {
    return (
      <section className={`${className} peer-sections`} aria-live="polite" {...testProps}>
        {disconnected ? <div className="ll-training-generation-banner">等待重连...</div> : null}
        {markdownBlock ? (
          <section className="ll-training-generation-peer-section">
            <div className="ll-training-generation-section-title">
              {complete ? <span className="ll-inline-sparkles" aria-hidden="true">✦</span> : <span className="ll-inline-spinner" aria-hidden="true" />}
              <span>{statusLabel}</span>
              {slow && onRetry ? <button type="button" className="ll-training-generation-inline-retry" onClick={onRetry}>重试</button> : null}
            </div>
            {markdownBlock}
          </section>
        ) : null}
        {tldrBlock ? (
          <section className="ll-training-generation-peer-section">
            <div className="ll-training-generation-section-title success">
              <span className="ll-training-generation-section-dot" aria-hidden="true" />
              <span>AI 提炼一句</span>
            </div>
            {tldrBlock}
          </section>
        ) : null}
        {trimmedSupplementMarkdown ? (
          <section className="ll-training-generation-supplement">
            <span>还没懂 → AI 补充</span>
            <div className="markdown-content ll-whitelisted-markdown">
              {renderWhitelistedMarkdownContent(trimmedSupplementMarkdown, "training-supplement-explanation")}
            </div>
          </section>
        ) : null}
        {error ? (
          <div className="ll-training-generation-fallback error">
            <p>{error}</p>
            <div className="ll-training-generation-fallback-actions">
              <button type="button" onClick={onRetry}>重试</button>
              {onSkip ? <button type="button" onClick={onSkip}>跳过</button> : null}
            </div>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className={className} aria-live="polite" {...testProps}>
      {disconnected ? <div className="ll-training-generation-banner">等待重连...</div> : null}
      <div className="ll-training-generation-meta">
        <div className="ll-training-generation-meta-copy">
          {complete ? <span className="ll-inline-sparkles" aria-hidden="true">✦</span> : <span className="ll-inline-spinner" aria-hidden="true" />}
          <span className="ll-training-generation-status-copy">
            <span>{statusLabel}</span>
            {statusDetail ? <small>{statusDetail}</small> : null}
          </span>
          {slow && onRetry ? <button type="button" className="ll-training-generation-inline-retry" onClick={onRetry}>重试</button> : null}
        </div>
      </div>
      {!shouldAppendTldr ? tldrBlock : null}
      {markdownBlock}
      {shouldAppendTldr ? tldrBlock : null}
      {trimmedSupplementMarkdown ? (
        <section className="ll-training-generation-supplement">
          <span>还没懂 → AI 补充</span>
          <div className="markdown-content ll-whitelisted-markdown">
            {renderWhitelistedMarkdownContent(trimmedSupplementMarkdown, "training-supplement-explanation")}
          </div>
        </section>
      ) : null}
      {error ? (
        <div className="ll-training-generation-fallback error">
          <p>{error}</p>
          <div className="ll-training-generation-fallback-actions">
            <button type="button" onClick={onRetry}>重试</button>
            {onSkip ? <button type="button" onClick={onSkip}>跳过</button> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
