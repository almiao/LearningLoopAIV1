import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocumentInput } from "../../../src/ingestion/document-parser.js";
import { createSession, answerSession } from "../../../src/tutor/session-orchestrator.js";
import { createHeuristicTutorIntelligence } from "../../../src/tutor/tutor-intelligence.js";

const intelligence = createHeuristicTutorIntelligence();
const casesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cases");

async function loadCase(fileName) {
  return JSON.parse(await readFile(path.join(casesDir, fileName), "utf8"));
}

test("threadlocal storage user case now supports closure with a standard interview takeaway", async () => {
  const userCase = await loadCase("threadlocal-storage-user-case.json");
  const source = parseDocumentInput({
    title: userCase.topic,
    content: `
ThreadLocal 的值不是放在线程外部的抽象“线程本地内存”里，而是存放在当前线程对象内部维护的 ThreadLocalMap 中。

调用 ThreadLocal.set(value) 时，当前线程会把这个 ThreadLocal 作为 key，把 value 写进自己的 ThreadLocalMap。

所以同一个 ThreadLocal 被不同线程访问时，本质上是在不同线程各自的 ThreadLocalMap 中查找对应值，因此线程之间互不干扰。

面试里最稳的说法是：Thread 持有 ThreadLocalMap，ThreadLocal 只是访问这个 map 的 key。
`
  });

  let session = await createSession({ source, intelligence, interactionPreference: "balanced" });
  session = await answerSession(session, {
    answer: "不知道",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });
  session = await answerSession(session, {
    answer: "总结一下",
    intent: "summarize",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });

  assert.equal(session.latestFeedback.action, "summarize", userCase.observed_problems.join("；"));
  assert.match(session.latestFeedback.takeaway, /ThreadLocalMap|Thread 持有 ThreadLocalMap/);
  assert.match(session.latestFeedback.explanation, /标准答案：/);
  assert.equal(session.currentProbe, "");
});

test("threadlocal leak user case now closes with the two required conditions instead of another long detour", async () => {
  const userCase = await loadCase("threadlocal-leak-user-case.json");
  const source = parseDocumentInput({
    title: userCase.topic,
    content: `
ThreadLocal 内存泄漏不是一句“没 remove”就能讲清的。

真正要成立，通常要同时看到 key 失效和线程长期存活这两个条件。

尤其在线程池场景里，工作线程会反复复用，如果 value 没被清掉，问题就会持续残留到后续任务。
`
  });
  const decomposition = {
    summary: {
      sourceTitle: userCase.topic,
      keyThemes: ["条件", "线程池", "弱引用"],
      framing: "threadlocal leak closure"
    },
    concepts: [
      {
        id: "leak-conditions",
        title: "ThreadLocal 泄漏触发条件",
        summary: "ThreadLocal 泄漏要同时满足两个条件：key 失效，且持有 value 的线程长期存活。",
        excerpt: "key 失效 + 线程长期存活",
        diagnosticQuestion: "ThreadLocal 真正泄漏要同时满足哪两个条件？",
        retryQuestion: "先别展开线程池，只说两个必要条件。",
        stretchQuestion: "为什么在线程池场景里这两个条件更容易同时出现？",
        checkQuestion: "现在用自己的话复述：为什么不是只有 remove 缺失就一定泄漏？",
        keywords: ["key 失效", "线程长期存活", "线程池"],
        sourceAnchors: ["key 失效", "线程长期存活"],
        misconception: "",
        importance: "core",
        coverage: "medium"
      },
      {
        id: "weak-ref",
        title: "弱引用 key 的作用",
        summary: "弱引用 key 只是让失联的 ThreadLocal 能被回收，它不会自动清掉仍被线程持有的 value。",
        excerpt: "弱引用 key 不等于自动清 value",
        diagnosticQuestion: "为什么 key 用弱引用不等于问题自动结束？",
        retryQuestion: "先只回答：弱引用解决了什么，没解决什么？",
        stretchQuestion: "为什么 value 还会残留在线程池线程里？",
        checkQuestion: "你现在复述：弱引用 key 的收益和边界分别是什么？",
        keywords: ["弱引用", "value 残留"],
        sourceAnchors: ["弱引用", "value"],
        misconception: "",
        importance: "secondary",
        coverage: "medium"
      },
      {
        id: "cleanup",
        title: "为什么要 remove",
        summary: "remove 的价值是及时把当前线程 ThreadLocalMap 里的脏 value 清掉，避免线程复用带来残留。",
        excerpt: "remove 清 value",
        diagnosticQuestion: "为什么 remove 才是真正兜底动作？",
        retryQuestion: "先说 remove 清掉的到底是什么。",
        stretchQuestion: "为什么线程结束和 remove 不是一回事？",
        checkQuestion: "现在用一句话讲：remove 到底在防什么？",
        keywords: ["remove", "线程复用"],
        sourceAnchors: ["remove"],
        misconception: "",
        importance: "secondary",
        coverage: "medium"
      }
    ]
  };

  let session = await createSession({
    source,
    intelligence,
    interactionPreference: "balanced",
    preparedDecomposition: decomposition
  });
  session = await answerSession(session, {
    answer: "没主动释放就会泄露吧",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });
  session = await answerSession(session, {
    answer: "总结一下",
    intent: "summarize",
    burdenSignal: "normal",
    interactionPreference: "balanced",
    intelligence
  });

  assert.equal(session.latestFeedback.action, "summarize", userCase.observed_problems.join("；"));
  assert.match(session.latestFeedback.takeaway, /两个条件|key|线程长期存活/);
  assert.equal(session.latestFeedback.turnResolution.mode, "stop");
  assert.equal(session.currentProbe, "");
});
