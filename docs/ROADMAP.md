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
- ✅ `src/ledger/{anchor-judge,practice-passthrough,extract-practice-round}.js` —— 适配器 + 穿透写入
- ✅ 接线:`/learn`(handleAnswer)与 loopassist 复盘两条 practice 回路都写账本
- ✅ 端到端实测:`npm run e2e:ledger`(走真 BFF + 真 LLM + 真 docPath)

### 判分质量(生死线)
- ✅ 24-case 校准 eval + `npm run eval:judge`,基线记录在 `ai-service/evals/BASELINE.md`
- ✅ harness 自身修正(error≠pass、mock/real 标签一致)

### act-led 首页(阶段 4 第一刀)
- ✅ "今日复习"读失败账本(`/api/review/today`)
- ✅ "学点新的"块(丢一篇 + 素材池)
- ✅ 砍文档库 4 分组(在读/已掌握/未学)、砍"系统记住了什么"、砍七日点阵
- ✅ 复习项点击 → 跳 `/learn` 重练(有原文指针的可点)

### 复习 practice 编排(闭环下半段)
- ✅ ai-service:`generate_review_question(复习项)` —— 薄封装 `generate_probe_question`,种子=handle+漏的锚点+上次的题,不起文档 session、不重跑拆解(`/api/review/generate-question`)
- ✅ BFF:`POST /api/review/{id}/practice`(`bff/src/lib/review-practice-domain.js`)—— 出题 → 锚点判分 → 过线转扎实 / 答崩补讲(复用 loopassist `rescue-material`,带确定性 fallback)→ `updateState`
- ✅ 前端:`/learn?reviewItem=` 进 ReviewPracticeWorkspace;首页今日复习所有项可点,删"来源不可达"
- ✅ 守 §1.3:纯现成零件编排,无新引擎、无新状态库;有 source_ref 带原文上下文,没有也可练
- ✅ 测试:`ai-service/tests/test_review_question.py` + `tests/unit/review-practice-domain.test.js`;真 LLM 全链路实测(出题/判崩/补讲/回写)

### 文档
- ✅ [ARCHITECTURE.md](ARCHITECTURE.md) + 流程图 + 术语表
- ✅ 过程性设计稿(docs/designs/)已清理(2026-06-12):页面已落地,线框图/Proposed 文档完成使命即删,事实源只留 PRODUCT / ARCHITECTURE / ROADMAP 三件套

---

## 待做 🔴 (按价值排序)

### P1 · Practice 合并
- 🔴 `learn-workspace`(4634)+ `loopassist-workspace`(2373)→ 一个 Practice 组件
- 🔴 loopassist 的对抗追问降为"题型参数档",不是独立页
- 复用 learn 的双栏阅读+practice 壳子
- ⚠️ 动手前先出具体方案给用户确认(组件边界/路由/状态迁移),确认后单独一刀

### P1 · 面试冲刺 · 就绪度/达标度
> 见 PRODUCT.md「面试冲刺」节。回答"我离这份 JD 还差多少"。
- ✅ campaign Goal(持久实体 ①):`src/goals/campaign-goal-store.js`,deadline + per-Goal 覆盖度清单,随战役生灭
- ✅ 覆盖度清单:JD 拆扁平话题(`ai-service /api/campaign/decompose-jd`,与已存简历交叉),逐个标 未覆盖/生疏/扎实
- ✅ 就绪度读数:覆盖率 + 达标度(重要度加权)+ 还差哪些(重要度×风险×1/剩余天数 排)+ 最可能被问崩 + 诚实边界声明
- ✅ 话题 practice:`POST /api/campaigns/{id}/topics/{tid}/practice` —— 同一套出题/判分/补讲零件,种子换成 JD 话题(§1.3 参数化);过线只标覆盖不写账本(碰过≠会),答崩写全局账本(同 handle 更新不重复建)
- ✅ deadline 感知调度(上半):账本 `next_due` 被战役 deadline 封顶(scheduleNextReview 的 deadline 参数透传)
- ✅ 面试后回灌:仪表盘"真被问崩的点"一行一条 → 直接转复习项(§面试冲刺 ⑦)
- ✅ 仪表盘页 `/campaign`:倒计时 + 覆盖度 + 就绪度 + 话题点击操练 + 模拟入口(loopassist)+ 归档;纯视图零自有状态
- ⛔ deadline 感知调度(下半)已砍(2026-06-12):时间压力不作为设计点(见「明确不做」);今日队列按风险单维排
- 🔴 "面到死"模式 = **逐步覆盖**:基于简历拆解 + JD 持续出题,直到覆盖面试相关的所有点;不是一次性模拟连播无早停。覆盖度怎么算(何时算"问遍了")后续与用户详细讨论再定
- ✅ 首页战役条:ActiveCampaignStrip 已有倒计时 + 覆盖率 + 今日优先补的话题(PRODUCT §3)

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
- ~~baseline-pack 训练写不出可点 source_ref(这类复习项点不了)~~ → 已被复习 practice 编排解决:re-practice 不再依赖 source_ref,所有复习项可练
- 🟡 账本去重/陈旧归档:反复 practice 会建重复项(§4 软肋,接受"冗余不是错误");需要陈旧项归档机制
- 🟡 判分跨模型校准:当前只测过 DeepSeek,OpenAI/Anthropic 未测

---

## 明确不做 ⛔ (反指标)

- ⛔ "系统记住了什么" / per-doc "已掌握" 一级页面(dashboard 反模式;掌握只能是账本派生)
- ⛔ 把首页变回文档库 / 稍后读 backlog
- ⛔ 先把资料拆成完整概念图(§1.6 失败驱动,不建模资料)
- ⛔ 让面试模式长出独立引擎/独立状态库(§1.3)
- ⛔ 面试当天实时识别/实时喂答案(已砍,§7)
- ⛔ 为"内容生成/问答"加重投入(§1.4 贬值区)
- ⛔ 把时间压力做成设计点(临近 deadline 压缩间隔、按剩余天数排序):工具 push 不动用户,只会让调度复杂难测。唯一例外是 next_due 被面试日期封顶(已做)——那是正确性,不是 push

---

## 三阶段收口计划(2026-06-12 与用户对齐)

**第一阶段:功能收尾 + 业务流程验收(进行中)**
1. 修 11 个存量失败 e2e(文案断言过期,先恢复测试可信度)
2. "面到死"逐步覆盖模式(方案先与用户讨论覆盖度计算)
3. 逐页面走查验收:首页 / library / learn / campaign / loopassist / profile / materials,按三条主流程验收(学新闭环 / 复习闭环 / 战役全路径)
4. Practice 合并:出方案 → 用户确认 → 单独一刀

**第二阶段:UI 整体统一**(前置:Practice 合并完成)
- design-system.css 收全量 token;learn 蓝 tint 收敛;语义三色(紫=训练/蓝=阅读/橙=面试)写成明文规范
- 验收:audit-dead-css 复跑 + 全量截图比对

**第三阶段:代码/文档/测试精简 → 清洁版本**
- capability-memory + src/mastery + memory-profile-store 链退役(关开关)
- 账本去重/陈旧项归档;source-regex 型单测评估转行为测试
- 三件套文档对齐 → 全绿打 tag

P2 调度真设计不进此计划:前置是真实使用数据,凭空调是浪费。
