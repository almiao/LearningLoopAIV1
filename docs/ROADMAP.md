# 路线图

> 完成项目的完整 TODO。状态:✅ 完成 · 🟡 进行中/部分 · 🔴 待做 · ⛔ 明确不做。
> 锚点:[PRODUCT.md](../PRODUCT.md)(产品事实源)+ [ARCHITECTURE.md](ARCHITECTURE.md)(流程)。

---

## 已完成 ✅

### 清理与去依赖
- ✅ 移出 `interview_assist` + `livekit-agent` + 阿里云实时 ASR(§7)
- ✅ `superapp` → `labs/`
- ✅ TTS 从单体 `main.py` 摘除,降为可选 worker;`start-services.sh` 加 `ENABLE_TTS` 守护(默认关)
- ✅ 零依赖可跑:`npm start` 不装 TTS/ML 也能跑通核心 loop

### 失败账本(脊柱,阶段 3)
- ✅ `src/ledger/review-item-store.js` —— 复习项账本(§4 五字段,JSON 存 `.omx/review-ledger/`)
- ✅ `ai-service/app/engine/anchor_judge.py` + `/api/anchor-judge` —— 锚点判分(防判太松)
- ✅ `src/ledger/{anchor-judge,drill-passthrough,extract-drill-round}.js` —— 适配器 + 穿透写入
- ✅ 接线:`/learn`(handleAnswer)与 loopassist 复盘两条 drill 回路都写账本
- ✅ 端到端实测:`npm run e2e:ledger`(走真 BFF + 真 LLM + 真 docPath)

### 判分质量(生死线)
- ✅ 24-case 校准 eval + `npm run eval:judge`,基线记录在 `ai-service/evals/BASELINE.md`
- ✅ harness 自身修正(error≠pass、mock/real 标签一致)

### act-led 首页(阶段 4 第一刀)
- ✅ "今日复习"读失败账本(`/api/review/today`)
- ✅ "学点新的"块(丢一篇 + 素材池)
- ✅ 砍文档库 4 分组(在读/已掌握/未学)、砍"系统记住了什么"、砍七日点阵
- ✅ 复习项点击 → 跳 `/learn` 重练(有原文指针的可点)

### 复习 drill 编排(闭环下半段)
- ✅ ai-service:`generate_review_question(复习项)` —— 薄封装 `generate_probe_question`,种子=handle+漏的锚点+上次的题,不起文档 session、不重跑拆解(`/api/review/generate-question`)
- ✅ BFF:`POST /api/review/{id}/drill`(`bff/src/lib/review-drill-domain.js`)—— 出题 → 锚点判分 → 过线转扎实 / 答崩补讲(复用 loopassist `rescue-material`,带确定性 fallback)→ `updateState`
- ✅ 前端:`/learn?reviewItem=` 进 ReviewDrillWorkspace;首页今日复习所有项可点,删"来源不可达"
- ✅ 守 §1.3:纯现成零件编排,无新引擎、无新状态库;有 source_ref 带原文上下文,没有也可练
- ✅ 测试:`ai-service/tests/test_review_question.py` + `tests/unit/review-drill-domain.test.js`;真 LLM 全链路实测(出题/判崩/补讲/回写)

### 文档
- ✅ [ARCHITECTURE.md](ARCHITECTURE.md) + 流程图 + 术语表
- ✅ [docs/designs/product-target-form-v1.md](designs/product-target-form-v1.md) —— 目标形态(线框 + 页面改动映射)

---

## 待做 🔴 (按价值排序)

### P1 · Practice 合并
- 🔴 `learn-workspace`(4634)+ `loopassist-workspace`(2373)→ 一个 Practice 组件
- 🔴 loopassist 的对抗追问降为"题型参数档",不是独立页
- 复用 learn 的双栏阅读+drill 壳子

### P1 · 面试战役 · 就绪度/达标度
> 见 PRODUCT.md「面试战役」节。回答"我离这份 JD 还差多少"。
- 🔴 覆盖度清单(per-Goal、随战役生灭):JD 拆扁平话题,逐个标 未覆盖/生疏/扎实
- 🔴 就绪度读数:覆盖率 + 最可能被问崩 + 还差哪些(按 风险×重要度×剩余天数 排)
- 🔴 deadline 感知调度:`next_due` 被 deadline 封顶、临近压缩间隔
- 🔴 "面到死"模式:模拟连播无早停 + 对抗拉满,批量收割薄弱点 → 灌账本 → 出就绪度读数
- 🔴 面试后回灌:真实失败转复习项(§面试战役 ⑦)

### P2 · 调度真设计
- 🔴 `next_due` 当前是占位(生疏+1d/扎实更长)。真调度不能直接套 SM-2/FSRS(§4 软肋)
- 前置:需要真实使用数据,别凭空调

### P2 · UI 设计系统统一
- 🔴 抽 `frontend/app/design-system.css`(`--ll-*` token + 卡片/pill/状态色统一)
- 前置:等内容形态稳定(Practice 合并后)

---

## 待清理 / 已知欠债 🟡

- 🟡 `capability-memory` + `src/mastery/` + `memory-profile-store` 链:首页已不渲染,但 BFF/profile-aggregator 还读。退役要跟首页/档案重构一起做(是"关开关",不是重写)
- 🟡 LibraryBrowser 内仍有 per-doc "在读/已掌握/未学" status badge(`tone-${group}`)
- ~~baseline-pack 训练写不出可点 source_ref(这类复习项点不了)~~ → 已被复习 drill 编排解决:re-drill 不再依赖 source_ref,所有复习项可练
- 🟡 账本去重/陈旧归档:反复 drill 会建重复项(§4 软肋,接受"冗余不是错误");需要陈旧项归档机制
- 🟡 判分跨模型校准:当前只测过 DeepSeek,OpenAI/Anthropic 未测

---

## 明确不做 ⛔ (反指标)

- ⛔ "系统记住了什么" / per-doc "已掌握" 一级页面(dashboard 反模式;掌握只能是账本派生)
- ⛔ 把首页变回文档库 / 稍后读 backlog
- ⛔ 先把资料拆成完整概念图(§1.6 失败驱动,不建模资料)
- ⛔ 让面试模式长出独立引擎/独立状态库(§1.3)
- ⛔ 面试当天实时识别/实时喂答案(已砍,§7)
- ⛔ 为"内容生成/问答"加重投入(§1.4 贬值区)

---

## 下一步建议

~~P0 复习 drill 编排~~ 已完成(2026-06-12),闭环正式闭上:账本里每条复习项都能
test-first 重练,过线转扎实、答崩补讲。下一刀在两个 P1 里选:
**面试就绪度**(产品差异化,纯增量、风险低)或 **Practice 合并**(两个巨型组件
合一,动现有行为、风险高,建议单独一刀)。其余按真实使用反馈再排。
