import {
  createConcept,
  normalizeWhitespace,
  safeSnippet,
  splitIntoParagraphs,
  splitIntoSentences,
  toReadableSourceText
} from "./material-model.js";

const keywordCatalog = [
  "aqs",
  "abstractqueuedsynchronizer",
  "clh",
  "state",
  "waitstatus",
  "tryacquire",
  "tryrelease",
  "tryacquireshared",
  "tryreleaseshared",
  "reentrantlock",
  "semaphore",
  "countdownlatch",
  "synchronizer",
  "同步器",
  "独占",
  "共享",
  "阻塞",
  "唤醒",
  "队列",
  "hashmap",
  "concurrenthashmap",
  "copyonwritearraylist",
  "list",
  "set",
  "map",
  "equals",
  "hashcode",
  "spring",
  "application context",
  "bean",
  "mysql",
  "transaction",
  "mvcc",
  "index",
  "redis",
  "cache",
  "http",
  "service"
];

function slugify(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "teaching-unit";
}

function extractKeywords(text) {
  const lowered = String(text ?? "").toLowerCase();
  const matched = keywordCatalog.filter((keyword) => lowered.includes(keyword));
  return matched.length > 0 ? matched : lowered.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean).slice(0, 6);
}

function deriveParagraphTitle(paragraph, index) {
  const lowered = paragraph.toLowerCase();

  if (/hashmap|concurrenthashmap|copyonwritearraylist|collection|list|set|map/.test(lowered)) {
    return "集合结构与选型";
  }

  if (/spring|application context|bean|autoconfiguration|dependency injection/.test(lowered)) {
    return "Spring Boot 运行机制";
  }

  if (/mysql|mvcc|transaction|index|innodb/.test(lowered)) {
    return "事务与索引推理";
  }

  if (/redis|cache|ttl|consistency/.test(lowered)) {
    return "缓存一致性取舍";
  }

  if (/http|service|request|response|backend/.test(lowered)) {
    return "服务链路与边界";
  }

  if (/thread|lock|concurrent|synchronized/.test(lowered)) {
    return "并发协调机制";
  }

  return `材料切入点 ${index + 1}`;
}

function isMeaningfulSection(section) {
  return section.title && section.text && section.text.length >= 48;
}

function extractMarkdownSections(source) {
  const rawContent = String(source.rawContent || source.content || "");
  if (!/^\s*##\s+/m.test(rawContent) && !/^\s*###\s+/m.test(rawContent)) {
    return [];
  }

  const lines = rawContent.replace(/\r/g, "").split("\n");
  const sections = [];
  let current = null;
  let sectionIndex = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headingMatch) {
      if (current) {
        sections.push(current);
      }

      current = {
        title: normalizeWhitespace(headingMatch[2]),
        depth: headingMatch[1].length,
        lines: [],
        index: sectionIndex
      };
      sectionIndex += 1;
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections
    .map((section) => ({
      title: section.title,
      depth: section.depth,
      index: section.index,
      text: toReadableSourceText(section.lines.join("\n"))
    }))
    .filter(isMeaningfulSection);
}

function extractParagraphSections(source) {
  return splitIntoParagraphs(source.content)
    .map((paragraph, index) => ({
      title: deriveParagraphTitle(paragraph, index),
      depth: 2,
      index,
      text: paragraph
    }))
    .filter(isMeaningfulSection);
}

function scoreSection(section) {
  let score = Math.min(section.text.length, 360) / 80;

  if (/[？?]/.test(section.title)) {
    score += 3;
  }

  if (/作用|为什么|核心|状态|模板方法|模式|区别|原理|同步器/.test(section.title)) {
    score += 2;
  }

  score += Math.min(extractKeywords(`${section.title} ${section.text}`).length, 6) * 0.35;
  score += section.depth === 3 || section.depth === 4 ? 0.5 : 0;

  return score;
}

function selectTeachingSections(source) {
  const sections = extractMarkdownSections(source);
  const fallbackSections = sections.length > 0 ? sections : extractParagraphSections(source);
  const ranked = fallbackSections
    .map((section) => ({
      section,
      score: scoreSection(section)
    }))
    .sort((left, right) => right.score - left.score || left.section.index - right.section.index);

  const selectedCount = Math.max(3, Math.min(6, ranked.length));
  return ranked
    .slice(0, selectedCount)
    .map((entry) => entry.section)
    .sort((left, right) => left.index - right.index);
}

function buildSummary(section) {
  const sentences = splitIntoSentences(section.text);
  return safeSnippet((sentences.slice(0, 2).join(" ") || section.text), 180);
}

function buildExcerpt(section) {
  const sentences = splitIntoSentences(section.text);
  return safeSnippet(sentences[0] || section.text, 200);
}

function buildMisconception(section) {
  if (/作用/.test(section.title)) {
    return "容易只说“它很重要”，但说不清 AQS 到底帮同步器屏蔽了哪些底层线程协调复杂度。";
  }

  if (/CLH|队列/.test(section.title)) {
    return "容易只背出 CLH 队列这个名词，却说不清它为什么比纯自旋更适合等待线程排队。";
  }

  if (/state|状态|waitstatus/i.test(section.title)) {
    return "容易记住状态名，但说不清这些状态如何影响线程排队、阻塞和唤醒。";
  }

  if (/模板方法|同步器/.test(section.title)) {
    return "容易背方法名，却说不清独占和共享两套获取/释放语义分别落在哪些钩子方法上。";
  }

  return `容易只复述“${section.title}”的表面结论，但没有讲清材料中的具体机制。`;
}

function buildImportance(section) {
  if (/作用|核心|状态|模板方法|CLH|队列/.test(section.title)) {
    return "core";
  }

  if (/模式|区别|对比|深入/.test(section.title)) {
    return "secondary";
  }

  return "secondary";
}

function buildCoverage(section) {
  if (section.text.length >= 260) {
    return "high";
  }

  if (section.text.length >= 120) {
    return "medium";
  }

  return "low";
}

function buildDiagnosticQuestion(section) {
  if (/[？?]$/.test(section.title)) {
    return `请直接回答：${section.title}`;
  }

  if (/AQS 介绍/.test(section.title)) {
    return "AQS 是什么？它在 Java 并发组件里扮演什么角色？";
  }

  if (/核心思想/.test(section.title)) {
    return "如果线程获取资源失败，AQS 接下来会怎样管理这个线程？请按材料里的机制来讲。";
  }

  if (/状态|waitstatus/i.test(section.title)) {
    return "AQS 里 waitStatus 的几个关键状态分别表示什么？至少讲清 SIGNAL 或 CANCELLED 的含义。";
  }

  if (/模板方法|自定义同步器/.test(section.title)) {
    return "如果基于 AQS 自定义同步器，一般需要重写哪些模板方法？它们分别负责什么？";
  }

  if (/独占|共享|模式/.test(section.title)) {
    return "AQS 的独占模式和共享模式在获取/释放资源语义上有什么区别？";
  }

  return `围绕“${section.title}”回答一个具体点：材料里它是怎么工作的？`;
}

function buildRetryQuestion(section) {
  if (/AQS 介绍/.test(section.title)) {
    return "先只回答一个点：AQS 在 Java 并发组件里到底扮演什么角色？";
  }

  if (/作用/.test(section.title)) {
    return "先只回答一个点：AQS 替同步器隐藏了哪类底层线程协调逻辑？";
  }

  if (/CLH|队列/.test(section.title)) {
    return "先只回答一个点：AQS 为什么不直接让线程一直纯自旋等待？";
  }

  if (/状态|waitstatus/i.test(section.title)) {
    return "先抓一个状态回答：SIGNAL 在队列里到底表示什么？";
  }

  if (/模板方法|自定义同步器/.test(section.title)) {
    return "先只回答一个点：tryAcquire 和 tryRelease 分别负责什么？";
  }

  if (/核心思想/.test(section.title)) {
    return "先聚焦流程：线程获取失败后，是直接忙等，还是进入等待队列？";
  }

  return `先只回答一个具体点：${section.title} 在材料里的关键机制是什么？`;
}

function buildStretchQuestion(section) {
  if (/CLH|队列/.test(section.title)) {
    return "继续深入：AQS 的 CLH 变体相对传统 CLH，至少改了哪两点？";
  }

  if (/模板方法|自定义同步器/.test(section.title)) {
    return "继续深入：独占和共享这两套模板方法，分别适合什么类型的同步器？";
  }

  if (/状态|waitstatus/i.test(section.title)) {
    return "继续深入：如果节点状态变成 CANCELLED，会对后续唤醒流程产生什么影响？";
  }

  return `继续深入：如果面试官追问“${section.title}”的边界条件，你会怎么补充？`;
}

function buildCheckQuestion(section) {
  if (/AQS 介绍/.test(section.title)) {
    return "不要复述原文，用你自己的话再讲一遍：AQS 为什么不是具体锁，而是同步器的底座？";
  }

  if (/CLH|队列/.test(section.title)) {
    return "现在用自己的话复述：如果不用队列而只靠纯自旋，材料里说会出什么问题？";
  }

  if (/状态|waitstatus/i.test(section.title)) {
    return "不要背定义，换个说法解释：SIGNAL 为什么会影响后继节点的唤醒？";
  }

  if (/模板方法|自定义同步器/.test(section.title)) {
    return "现在别列方法名，直接说：为什么自定义同步器要分别实现获取和释放这两类钩子？";
  }

  return `现在用你自己的话复述一下：“${section.title}”在材料里的关键机制是什么？`;
}

function buildRemediationHint(section, summary) {
  return `先抓住材料里的关键点：${summary} 常见卡点是：${buildMisconception(section)}`;
}

function createTeachingConcept(section, index) {
  const summary = buildSummary(section);
  const excerpt = buildExcerpt(section);

  return createConcept({
    id: `${slugify(section.title)}-${index + 1}`,
    title: section.title,
    summary,
    excerpt,
    keywords: extractKeywords(`${section.title} ${section.text}`),
    sourceAnchors: [excerpt],
    order: index + 1,
    misconception: buildMisconception(section),
    importance: buildImportance(section),
    coverage: buildCoverage(section),
    diagnosticQuestion: buildDiagnosticQuestion(section),
    retryQuestion: buildRetryQuestion(section),
    stretchQuestion: buildStretchQuestion(section),
    checkQuestion: buildCheckQuestion(section),
    remediationHint: buildRemediationHint(section, summary)
  });
}

function createFallbackConcept(source, index) {
  const paragraph = splitIntoParagraphs(source.content)[index] || source.content;
  const section = {
    title: deriveParagraphTitle(paragraph, index),
    text: paragraph
  };
  return createTeachingConcept(section, index);
}

export function decomposeSource(source) {
  const selectedSections = selectTeachingSections(source);
  const concepts = selectedSections.map((section, index) => createTeachingConcept(section, index));

  if (concepts.length > 0) {
    return concepts;
  }

  return Array.from({ length: 3 }, (_, index) => createFallbackConcept(source, index));
}

export function summarizeSourceForDisplay(source, concepts) {
  const topConcepts = concepts.slice(0, 3).map((concept) => concept.title);
  return {
    sourceTitle: source.title,
    keyThemes: topConcepts,
    framing: `我先从材料里提炼出 ${topConcepts.join("、")} 这些切入点，然后围绕其中的具体机制来出题，而不是直接做泛泛而谈的追问。`
  };
}

export function generateInitialProbe(concept) {
  return (
    concept.diagnosticQuestion ||
    `围绕“${concept.title}”回答一个具体点：材料里它的关键机制是什么？`
  );
}
