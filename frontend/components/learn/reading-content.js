"use client";

import { renderMarkdownContent } from "../../lib/render-markdown-content";
import { slugifyHeading } from "../../lib/render-markdown-content";
import { MiniIcon } from "./shared";

function cleanInlineMarkdown(value = "") {
  return String(value || "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseReadingTableCells(line = "") {
  return String(line || "")
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cleanInlineMarkdown(cell));
}

function isReadingTableDivider(line = "") {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(String(line || ""));
}

function readReadingTableBlock(lines = [], startIndex = 0) {
  const header = parseReadingTableCells(lines[startIndex]);
  const rows = [];
  let nextIndex = startIndex + 2;

  while (nextIndex < lines.length) {
    const line = String(lines[nextIndex] || "").trim();
    if (!line || !line.includes("|") || /^#{1,6}\s+/.test(line) || /^(```|~~~)/.test(line)) {
      break;
    }
    rows.push(parseReadingTableCells(line));
    nextIndex += 1;
  }

  return { header, rows, nextIndex };
}

export function buildReadingBlocks(markdown = "") {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const blocks = [];
  let paragraph = [];
  function flushParagraph() {
    const text = cleanInlineMarkdown(paragraph.join(" "));
    paragraph = [];
    if (!text) {
      return;
    }
    const paragraphIndex = blocks.filter((block) => block.type === "paragraph").length + 1;
    const keyPhrase = text.includes("六代关键演进")
      ? "六代关键演进"
      : /2022.+2025/.test(text)
        ? "2022 年到 2025 年"
        : "";
    blocks.push({
      id: `reading-paragraph-${paragraphIndex}`,
      type: "paragraph",
      text,
      paragraphIndex,
      important: Boolean(keyPhrase) || paragraphIndex === 4,
      keyPhrase: keyPhrase || (paragraphIndex === 4 ? "AI Agent" : ""),
    });
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] || "";
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (lineIndex + 1 < lines.length && line.includes("|") && isReadingTableDivider(lines[lineIndex + 1])) {
      flushParagraph();
      const table = readReadingTableBlock(lines, lineIndex);
      blocks.push({
        id: `reading-table-${blocks.length + 1}`,
        type: "table",
        header: table.header,
        rows: table.rows,
      });
      lineIndex = table.nextIndex - 1;
      continue;
    }
    const imageMatch = line.match(/^!\[([^\]]*)]\(([^)]+)\)/);
    if (imageMatch) {
      flushParagraph();
      blocks.push({
        id: `reading-image-${blocks.length + 1}`,
        type: "image",
        alt: cleanInlineMarkdown(imageMatch[1] || "文档配图"),
        src: imageMatch[2],
      });
      continue;
    }
    const fenceMatch = line.match(/^(```|~~~)\s*([\w-]+)?/);
    if (fenceMatch) {
      flushParagraph();
      const fence = fenceMatch[1];
      const language = (fenceMatch[2] || "").trim().toLowerCase();
      const codeLines = [];
      lineIndex += 1;
      while (lineIndex < lines.length) {
        const candidate = String(lines[lineIndex] || "");
        if (candidate.trim().startsWith(fence)) {
          break;
        }
        codeLines.push(candidate);
        lineIndex += 1;
      }
      blocks.push({
        id: `reading-code-${blocks.length + 1}`,
        type: "code",
        language,
        text: codeLines.join("\n").trim(),
      });
      continue;
    }
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        id: `reading-heading-${blocks.length + 1}`,
        type: headingMatch[1].length === 2 ? "h2" : "h3",
        text: cleanInlineMarkdown(headingMatch[2]),
      });
      continue;
    }
    if (/^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      flushParagraph();
      const text = cleanInlineMarkdown(line.replace(/^([-*+]|\d+\.)\s+/, ""));
      if (text) {
        const paragraphIndex = blocks.filter((block) => block.type === "paragraph").length + 1;
        blocks.push({
          id: `reading-paragraph-${paragraphIndex}`,
          type: "paragraph",
          text,
          paragraphIndex,
          important: text.includes("六代进化") || text.includes("六代关键演进"),
          keyPhrase: text.includes("六代") ? "六代" : "",
        });
      }
      continue;
    }
    if (/^```/.test(line) || /^---+$/.test(line)) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks.length ? blocks : [{
    id: "reading-paragraph-1",
    type: "paragraph",
    text: "这篇文档已经进入资料库，开始阅读后会持续记录进度、重点和后续训练结果。",
    paragraphIndex: 1,
    important: false,
    keyPhrase: "",
  }];
}

export function getDocumentTextForReading(document = {}) {
  return document?.learning?.markdown || document?.markdown || document?.learning?.text || "";
}

function getWordCountLabel(markdown = "") {
  const text = cleanInlineMarkdown(markdown);
  const count = text.length;
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}w 字`;
  }
  return `${Math.max(1, Math.round(count / 1000))}k 字`;
}

function getReadingMinutes(markdown = "") {
  const count = cleanInlineMarkdown(markdown).length;
  return Math.max(1, Math.round(count / 520));
}

export function buildReadingResumeContext(blocks = [], scrollRatio = 0) {
  const contentBlocks = blocks.filter((block) => block.type === "paragraph" || block.type === "h2" || block.type === "h3");
  if (!contentBlocks.length) {
    return {
      readingPreview: "",
      readingChapter: "",
    };
  }

  const safeRatio = Math.min(1, Math.max(0, Number(scrollRatio || 0)));
  const currentIndex = Math.min(contentBlocks.length - 1, Math.max(0, Math.floor(safeRatio * contentBlocks.length)));
  const currentBlock = contentBlocks[currentIndex];
  const previousHeading = contentBlocks
    .slice(0, currentIndex + 1)
    .reverse()
    .find((block) => block.type === "h2" || block.type === "h3");
  const previewSource = currentBlock?.text || previousHeading?.text || "";
  const readingPreview = cleanInlineMarkdown(previewSource).slice(0, 96);

  return {
    readingPreview,
    readingChapter: previousHeading?.text || "",
  };
}

function getSourceHost(document = {}) {
  const url = document?.source?.url || document?.originalSource?.url || "";
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {}
  }
  if (document?.providerLabel) {
    return document.providerLabel;
  }
  return "javaguide.cn";
}

function renderTextWithHighlight(text = "", phrase = "") {
  if (!phrase || !text.includes(phrase)) {
    return text;
  }
  const parts = text.split(phrase);
  return parts.flatMap((part, index) => (
    index === parts.length - 1
      ? [part]
      : [part, <mark className="reading-keyword-highlight" key={`${phrase}:${index}`}>{phrase}</mark>]
  ));
}

export function ReadingSelectionPopover({ popover, onAsk, onQuiz, onSave, onHighlight, onClose }) {
  if (!popover?.visible) {
    return null;
  }
  return (
    <section
      className="reading-selection-popover"
      style={{ left: popover.x, top: popover.y }}
      data-testid="reading-selection-popover"
    >
      <div className="reading-selection-chip">划线段落 · 选择操作</div>
      <div className="reading-selection-actions">
        <button type="button" className="primary" onClick={onAsk}>AI 解释</button>
        <button type="button" onClick={onQuiz}>出题考我</button>
        <button type="button" onClick={onSave}>记下来</button>
        <button type="button" onClick={onHighlight}>高亮</button>
      </div>
      <button type="button" className="reading-selection-close" aria-label="关闭划线操作" onClick={onClose}>×</button>
    </section>
  );
}

export function ReadingDocumentContent({
  document,
  blocks,
  readProgress,
  highlightedParagraphId,
  userHighlightedParagraphIds,
  onParagraphAction,
  onBookmark,
}) {
  const markdown = getDocumentTextForReading(document);
  const readingMinutes = getReadingMinutes(markdown);
  const remainingMinutes = Math.max(1, Math.round(readingMinutes * (1 - readProgress / 100)));
  const headings = blocks.filter((block) => block.type === "h2" || block.type === "h3");
  const currentChapter = headings[Math.min(headings.length - 1, Math.max(0, Math.floor((readProgress / 100) * headings.length)))]?.text || "前言";

  return (
    <article className="document-surface reading-document-surface" data-testid="document-surface">
      <div className="reading-doc-meta">
        <span>来源<br />{getSourceHost(document)}</span>
        <span>{getWordCountLabel(markdown)} · 约 {readingMinutes} 分钟</span>
        <span>已读<br /><strong>{readProgress}%</strong></span>
        <span>继续读 {remainingMinutes} 分钟</span>
      </div>
      <div className="reading-document-flow">
        {blocks.map((block) => {
          if (block.type === "h2" || block.type === "h3") {
            const Heading = block.type;
            return <Heading key={block.id} id={slugifyHeading(block.text)}>{block.text}</Heading>;
          }
          if (block.type === "image") {
            return (
              <img
                key={block.id}
                className="markdown-image reading-document-image"
                src={block.src}
                alt={block.alt}
                loading="lazy"
              />
            );
          }
          if (block.type === "code") {
            const isMermaid = block.language === "mermaid";
            return (
              <figure key={block.id} className={isMermaid ? "reading-code-block is-mermaid-source" : "reading-code-block"}>
                {isMermaid ? <figcaption>Mermaid 图表暂以源码显示</figcaption> : null}
                <pre className="markdown-pre">
                  <code data-language={block.language || undefined}>{block.text}</code>
                </pre>
              </figure>
            );
          }
          if (block.type === "table") {
            const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.length));
            return (
              <div key={block.id} className="markdown-table-wrap reading-document-table">
                <table className="markdown-table">
                  <thead>
                    <tr>
                      {Array.from({ length: columnCount }).map((_, cellIndex) => (
                        <th key={`${block.id}-head-${cellIndex}`}>{block.header[cellIndex] || ""}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${block.id}-row-${rowIndex}`}>
                        {Array.from({ length: columnCount }).map((_, cellIndex) => (
                          <td key={`${block.id}-cell-${rowIndex}-${cellIndex}`}>{row[cellIndex] || ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          const isHighlighted = highlightedParagraphId === block.id || userHighlightedParagraphIds.includes(block.id);
          return (
            <p
              key={block.id}
              id={block.id}
              className={[
                "reading-paragraph",
                block.important ? "is-ai-highlighted" : "",
                isHighlighted ? "is-user-highlighted" : "",
                highlightedParagraphId === block.id ? "is-citation-flash" : "",
              ].filter(Boolean).join(" ")}
              data-reading-paragraph={block.id}
              onClick={(event) => {
                if (block.important) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onParagraphAction({
                    visible: true,
                    x: Math.min(window.innerWidth - 320, Math.max(18, rect.left + 18)),
                    y: Math.min(window.innerHeight - 132, Math.max(72, rect.bottom + 10)),
                    text: block.text,
                    paragraphId: block.id,
                  });
                }
              }}
            >
              {renderTextWithHighlight(block.text, block.keyPhrase)}
            </p>
          );
        })}
      </div>
      <footer className="reading-chapter-footer">
        <span>{`第 ${Math.max(1, Math.round((readProgress / 100) * Math.max(1, headings.length)))} 章 · ${currentChapter}`}</span>
        <button type="button" onClick={onBookmark}>
          <MiniIcon name="bookmark" />
          记住这里，下次继续
        </button>
      </footer>
    </article>
  );
}

function CitationButton({ value, onClick }) {
  return (
    <sup>
      <button type="button" className="reading-citation" onClick={() => onClick(value)}>
        {value}
      </button>
    </sup>
  );
}

export function normalizeAssistantMarkdown(value = "") {
  return String(value || "")
    .replace(/\s+(#{1,4}\s+)/g, "\n\n$1")
    .replace(/\s+(-{3,})\s+/g, "\n\n$1\n\n")
    .replace(/\s+(-\s+\*\*)/g, "\n$1")
    .replace(/\s+(\d+\.\s+\*\*)/g, "\n$1")
    .trim();
}

export function ReadingAssistantBubble({ entry, onCitationClick }) {
  if (entry.role === "assistant") {
    return (
      <article className={`message-card assistant reading-ai-message ${entry.isProgressUpdate ? "progress-update" : ""}`}>
        {!entry.isProgressUpdate ? <div className="reading-message-meta">AI</div> : null}
        <div className={`message-body ${entry.body ? "markdown-content" : ""}`}>
          {entry.body ? (
            renderMarkdownContent(normalizeAssistantMarkdown(entry.body), `${entry.id || "reading-ai"}-assistant`)
          ) : (
            <p>
              本质区别在于 <mark>推理框架的引入</mark>。第二代依赖人类逐步提示，第三代通过 ReAct 框架让 Agent 自主完成“思考-行动-观察”循环
              <CitationButton value={2} onClick={onCitationClick} />
              ，实现了自治能力的关键跃迁
              <CitationButton value={5} onClick={onCitationClick} />。
            </p>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className="message-card learner reading-user-message">
      <div className="reading-message-meta">你 · 2 分钟前</div>
      <div className="message-body">
        {(entry.bodyParts?.length ? entry.bodyParts : [entry.body]).filter(Boolean).map((block, index) => (
          <p key={`${entry.id || "message"}:${index}`}>{block}</p>
        ))}
      </div>
    </article>
  );
}
