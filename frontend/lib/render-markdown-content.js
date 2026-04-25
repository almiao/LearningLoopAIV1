import React from "react";

export function slugifyHeading(text) {
  const slug = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function parseMarkdownTarget(rawTarget = "") {
  const trimmed = String(rawTarget || "").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : trimmed;
}

function renderInlineMarkdown(text, keyPrefix) {
  return String(text || "")
    .split(/(!\[[^\]]*]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("![") && part.includes("](") && part.endsWith(")")) {
        const imageMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (!imageMatch) {
          return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
        }
        return (
          <img
            key={`${keyPrefix}-image-${index}`}
            alt={imageMatch[1]}
            className="markdown-image"
            loading="lazy"
            src={parseMarkdownTarget(imageMatch[2])}
          />
        );
      }
      if (part.startsWith("[") && part.includes("](") && part.endsWith(")")) {
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (!linkMatch) {
          return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
        }
        const href = parseMarkdownTarget(linkMatch[2]);
        const isInternal = href.startsWith("/") || href.startsWith("#");
        return (
          <a
            key={`${keyPrefix}-link-${index}`}
            href={href}
            rel={isInternal ? undefined : "noreferrer"}
            target={isInternal ? undefined : "_blank"}
          >
            {linkMatch[1]}
          </a>
        );
      }
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={`${keyPrefix}-code-${index}`}>{part.slice(1, -1)}</code>;
      }
      return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
    });
}

export function readHeading(line) {
  const match = String(line || "").trim().match(/^(#{1,6})\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    level: Math.min(match[1].length, 4),
    text: match[2].trim(),
  };
}

function readOrderedItem(line) {
  const match = String(line || "").trim().match(/^\d+\.\s+(.*)$/);
  return match ? match[1].trim() : "";
}

function readBulletItem(line) {
  const match = String(line || "").match(/^\s*[-*]\s+(.*)$/);
  return match ? match[1].trim() : "";
}

function parseTableCells(line) {
  const trimmed = String(line || "").trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(String(line || ""));
}

export function renderMarkdownContent(value, keyPrefix) {
  const normalized = String(value || "").replace(/\r/g, "").trim();
  if (!normalized) {
    return null;
  }

  const lines = normalized.split("\n");
  const nodes = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const rawLine = lines[index] || "";
    const trimmedLine = rawLine.trim();

    if (!trimmedLine) {
      index += 1;
      continue;
    }

    if (/^(```|~~~)/.test(trimmedLine)) {
      const fence = trimmedLine.slice(0, 3);
      const language = trimmedLine.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !String(lines[index] || "").trim().startsWith(fence)) {
        codeLines.push(lines[index] || "");
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      nodes.push(
        <pre key={`${keyPrefix}-code-${blockIndex}`} className="markdown-pre">
          <code data-language={language || undefined}>{codeLines.join("\n")}</code>
        </pre>
      );
      blockIndex += 1;
      continue;
    }

    const heading = readHeading(trimmedLine);
    if (heading) {
      const HeadingTag = `h${heading.level}`;
      nodes.push(
        <HeadingTag key={`${keyPrefix}-h-${blockIndex}`} id={slugifyHeading(heading.text)}>
          {renderInlineMarkdown(heading.text, `${keyPrefix}-h-${blockIndex}`)}
        </HeadingTag>
      );
      blockIndex += 1;
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && trimmedLine.includes("|") && isTableDivider(lines[index + 1])) {
      const headerCells = parseTableCells(trimmedLine);
      const bodyRows = [];
      index += 2;
      while (index < lines.length && String(lines[index] || "").trim().includes("|")) {
        bodyRows.push(parseTableCells(lines[index]));
        index += 1;
      }
      nodes.push(
        <div key={`${keyPrefix}-table-${blockIndex}`} className="markdown-table-wrap">
          <table className="markdown-table">
            <thead>
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th key={`${keyPrefix}-table-${blockIndex}-head-${cellIndex}`}>
                    {renderInlineMarkdown(cell, `${keyPrefix}-table-${blockIndex}-head-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={`${keyPrefix}-table-${blockIndex}-row-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${keyPrefix}-table-${blockIndex}-cell-${rowIndex}-${cellIndex}`}>
                      {renderInlineMarkdown(cell, `${keyPrefix}-table-${blockIndex}-cell-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      blockIndex += 1;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmedLine)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s+/.test((lines[index] || "").trim())) {
        items.push(lines[index].trim());
        index += 1;
      }
      nodes.push(
        <ol key={`${keyPrefix}-ol-${blockIndex}`}>
          {items.map((line, lineIndex) => (
            <li key={`${keyPrefix}-ol-${blockIndex}-${lineIndex}`}>
              {renderInlineMarkdown(readOrderedItem(line), `${keyPrefix}-ol-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ol>
      );
      blockIndex += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(rawLine)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] || "")) {
        items.push(lines[index]);
        index += 1;
      }
      nodes.push(
        <ul key={`${keyPrefix}-ul-${blockIndex}`}>
          {items.map((line, lineIndex) => (
            <li key={`${keyPrefix}-ul-${blockIndex}-${lineIndex}`}>
              {renderInlineMarkdown(readBulletItem(line), `${keyPrefix}-ul-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ul>
      );
      blockIndex += 1;
      continue;
    }

    if (/^>/.test(trimmedLine)) {
      const quoteLines = [];
      while (index < lines.length && /^>/.test(String(lines[index] || "").trim())) {
        quoteLines.push(String(lines[index] || "").trim().replace(/^>\s?/, ""));
        index += 1;
      }
      nodes.push(
        <blockquote key={`${keyPrefix}-quote-${blockIndex}`}>
          {renderMarkdownContent(quoteLines.join("\n"), `${keyPrefix}-quote-${blockIndex}`)}
        </blockquote>
      );
      blockIndex += 1;
      continue;
    }

    if (/^---+$/.test(trimmedLine)) {
      nodes.push(<hr key={`${keyPrefix}-hr-${blockIndex}`} />);
      blockIndex += 1;
      index += 1;
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const currentLine = lines[index] || "";
      const trimmedCurrentLine = currentLine.trim();
      if (!trimmedCurrentLine) {
        index += 1;
        break;
      }
      if (
        paragraphLines.length &&
        (
          /^(```|~~~)/.test(trimmedCurrentLine) ||
          readHeading(trimmedCurrentLine) ||
          /^\d+\.\s+/.test(trimmedCurrentLine) ||
          /^\s*[-*]\s+/.test(currentLine) ||
          /^>/.test(trimmedCurrentLine) ||
          /^---+$/.test(trimmedCurrentLine) ||
          (trimmedCurrentLine.includes("|") && isTableDivider(lines[index + 1]))
        )
      ) {
        break;
      }
      paragraphLines.push(trimmedCurrentLine);
      index += 1;
    }

    if (paragraphLines.length) {
      nodes.push(
        <p key={`${keyPrefix}-p-${blockIndex}`}>
          {renderInlineMarkdown(paragraphLines.join(" "), `${keyPrefix}-p-${blockIndex}`)}
        </p>
      );
      blockIndex += 1;
    }
  }

  return nodes;
}
