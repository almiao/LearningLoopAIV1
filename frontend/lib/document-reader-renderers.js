import { renderMarkdownContent } from "./render-markdown-content";
import { buildApiUrl } from "./api";
import { PdfReaderView } from "../components/pdf-reader-view";

function renderRawText(value, className = "document-plain-text") {
  return <pre className={className}>{String(value || "").trim() || "暂无可显示内容。"}</pre>;
}

function renderIframeSurface(
  document,
  {
    fallbackCopy = "正在查看原始资料。若浏览器无法直接预览，可以打开原链接。",
    badgeLabel = "原文预览",
    frameClassName = "",
  } = {}
) {
  const rawViewUrl = document?.render?.viewUrl || document?.originalSource?.viewUrl || document?.originalSource?.url || "";
  const rawOpenUrl = document?.render?.fallbackUrl || rawViewUrl;
  const viewUrl = rawViewUrl ? buildApiUrl(rawViewUrl) : "";
  const openUrl = rawOpenUrl ? buildApiUrl(rawOpenUrl) : "";
  return (
    <article className={`document-surface original-source-surface ${frameClassName}`.trim()} data-testid="original-source-surface">
      <div className="original-source-card">
        <div className="original-source-copy">
          <span className="original-source-badge">{badgeLabel}</span>
          <p>{fallbackCopy}</p>
        </div>
        {openUrl ? (
          <a className="primary-pill" href={openUrl} target="_blank" rel="noreferrer">
            打开原文
          </a>
        ) : null}
      </div>
      {document?.render?.previewable && viewUrl ? (
        <iframe
          title={`${document?.title || "原文"} 原文`}
          className="original-source-frame"
          src={viewUrl}
        />
      ) : null}
    </article>
  );
}

function buildReaderScaleStyle(readerZoom = 100) {
  const numericZoom = Number(readerZoom);
  const scale = Number.isFinite(numericZoom) ? numericZoom / 100 : 1;
  return {
    "--reader-scale": scale,
  };
}

function renderLearningMarkdown(document, options = {}) {
  const markdown = document?.learning?.markdown || document?.markdown || "";
  return (
    <article
      className="document-surface document-markdown markdown-content"
      data-testid="document-surface"
      style={buildReaderScaleStyle(options.readerZoom)}
    >
      {renderMarkdownContent(markdown, `knowledge-doc:${document?.path || "unknown"}`)}
    </article>
  );
}

function renderOriginalText(document, options = {}) {
  const format = document?.render?.format || document?.primaryFormat || "text";
  const textValue = format === "markdown"
    ? (document?.learning?.markdown || document?.markdown || "")
    : (document?.learning?.text || "");
  return (
    <article
      className="document-surface original-source-surface"
      data-testid="original-source-surface"
      style={buildReaderScaleStyle(options.readerZoom)}
    >
      <div className="original-source-card">
        <p>正在查看原始资料文本。</p>
      </div>
      <div className="document-plain-surface">
        {renderRawText(textValue)}
      </div>
    </article>
  );
}

export const readerRendererRegistry = {
  html: {
    renderOriginal: (document) => renderIframeSurface(document),
    renderLearning: renderLearningMarkdown,
  },
  pdf: {
    renderOriginal: (document, options = {}) => (
      <PdfReaderView
        title={document?.title || ""}
        fileUrl={buildApiUrl(document?.render?.viewUrl || document?.originalSource?.viewUrl || document?.originalSource?.url || "")}
        readerZoom={options.readerZoom}
      />
    ),
    renderLearning: renderLearningMarkdown,
  },
  text: {
    renderOriginal: renderOriginalText,
    renderLearning: renderLearningMarkdown,
  },
  markdown: {
    renderOriginal: renderOriginalText,
    renderLearning: renderLearningMarkdown,
  },
  unsupported: {
    renderOriginal: (document) => renderIframeSurface(document, "当前格式暂不支持内嵌原文，已保留原文件入口。"),
    renderLearning: renderLearningMarkdown,
  },
};

export function getReaderRenderer(document = {}) {
  const format = document?.render?.format || document?.primaryFormat || "markdown";
  return readerRendererRegistry[format] || readerRendererRegistry.unsupported;
}

export function getDocumentOutline(document = {}) {
  const outline = Array.isArray(document?.learning?.outline) ? document.learning.outline : [];
  if (outline.length) {
    return outline;
  }
  return [];
}
