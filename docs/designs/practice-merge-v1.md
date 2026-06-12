# Practice 合并 · 设计与实施计划 v1

> 2026-06-12 与用户对齐的定稿方案。过程性设计稿，完成使命即删（同 docs/designs 既往惯例）。
> 三条裁决：①范围确认，雷达复盘报告本次不动；②**模拟面试保持一级产品点**，合并的是内核不是入口；③按 1→2 连做、3、4 各单独一刀的顺序执行。

---

## 1. 背景与目标

同一个「出题 → 作答 → 判分 → 反馈」循环散落四处，互相复制演化：

| 位置 | 规模 | 特有部分 | 共享判分零件 |
|---|---|---|---|
| learn 训练模式（learn-workspace.js 主体） | 文件共 4634 行 | 流式作答、训练点 checkpoint、训练进度栏、双栏阅读联动 | `ll-thread-score-summary` / `ll-thread-support-grid` / TrainingGenerationPanel |
| ReviewPracticeWorkspace（learn-workspace.js:455–596 内嵌） | ~140 行 | 复习项证据 + 锚点列表展示 | 同上（同款 class 复制） |
| campaign TopicPracticeView（campaign-dashboard.js:104–253 内嵌） | ~150 行 | JD 话题种子、覆盖度回写 | 同上（同款 class 复制） |
| loopassist 面试循环（loopassist-workspace.js） | 2373 行 | setup 向导、多轮对抗追问、大纲仪式、雷达复盘报告 | 自有一套（黑色品牌世界） |

**目标**：练习循环只有一份实现（PracticeShell），差异全部表达为参数（种子类型、对抗强度、流式与否）。守 PRODUCT §1.3：纯现成零件编排，无新引擎、无新状态库。

**非目标（本次不做）**：
- 雷达复盘报告（CapabilityRadar + buildReviewStats 等，loopassist-workspace.js:441–605）——它是报告视图不是练习循环，整体保留。
- UI 视觉统一（design token 收敛）——第二阶段的事；本计划只在第 4 步顺带消灭 loopassist 黑色外壳。
- 调度真设计、账本去重——见 PLAN.md 第三阶段。

---

## 2. 关键架构事实（已核实）

- **路由已统一**：`/loopassist/page.js` 只是 redirect 到 `/learn?mode=interview`；分发在 `frontend/app/learn/page.js` 一处（`mode=interview|loopassist` → LoopAssistWorkspace，`?reviewItem=` → ReviewPracticeWorkspace，否则 LearnWorkspace）。合并是纯组件层工作，无路由迁移。
- **判分结果区已是三胞胎**：复习练（learn-workspace.js:538–580）、话题练（campaign-dashboard.js:210–245）的结果标记完全同构：`ll-thread-score-summary tone-solid/weak` + 讲到位/没讲到 support-grid + 补讲卡（TrainingGenerationPanel，testid `*-rescue-card`）。
- **API 面**（合并不改任何接口）：
  - 复习练：`POST /api/review/{id}/practice`（action: start/answer）
  - 话题练：`POST /api/campaigns/{id}/topics/{tid}/practice`（action: start/answer）
  - 训练：`POST /api/interview/start-target` + `/api/interview/answer-stream`（SSE 流式）
  - 模拟面试：`frontend/lib/loopassist-api.js` 全家（options/preview-scope/start/answer-stream/review/rescue-playlist）
- **localStorage 状态**：learn 侧 `learning-loop-learn-panel-layout` / `learning-loop-reader-zoom-v1` / profileDirty；loopassist 侧 `interviewRecordStorageKey`（面试记录恢复）。互不冲突，合并时原样保留 key 名，**无迁移成本**。
- **e2e 安全网**（当前全绿，42 过）：reading-companion / reentry-intents（训练+阅读）、campaign.pw（话题练全路径）、loopassist.pw（模拟面试 mock 流）、home-reading-memory（复习入口）。每步收尾必须全绿。

---

## 3. 目标组件结构

```
frontend/components/practice/
├── practice-shell.js      # 练习循环壳：题面卡 + 作答框 + 判分结果 + 动作行
├── practice-result.js     # 判分结果区（score-summary + hits/misses + 补讲卡）
├── review-practice.js     # 复习练页（从 learn-workspace.js 搬出，调 shell）
└── seed-types.js          # 种子类型档案（见 §4）
```

### PracticeShell 契约（props 即参数档）

```js
<PracticeShell
  seed={{ type, payload }}        // 种子：题从哪来（见 §4）
  endpoints={{ start, answer }}   // 出题/判分端点（各调用方自带，shell 不知道 URL 规则）
  streaming={false}               // 训练/面试模式开 SSE 流式作答
  adversarial="off"               // off | followup：多轮追问档（第 4 步引入）
  onJudged={(result) => {}}       // 判分回调：覆盖度回写 / 账本透传由调用方处理
  renderEvidence={() => {}}       // 可选插槽：复习项证据锚点 / 话题来源标注
  actions={{ retry: "同话题再练", next: "练下一个" }}  // 动作行文案由调用方定（大白话纪律）
/>
```

原则：**shell 管循环，不管业务**。覆盖度回写、账本写入、战役状态更新全部留在调用方（campaign-dashboard / review-practice / learn 训练编排），shell 只透传判分结果。

### PracticeResult 契约

纯展示组件：`{ passed, hits, misses, rescueMarkdown, passLabel, failLabel }`。
三处现有副本（复习练/话题练/训练 thread 的判分块）逐步换成它；文案差异（"过了 · 标记为扎实" vs 训练态文案）走 props，不在组件里写死。

---

## 4. 三种出题类型（种子类型档案）

> 用户裁决（2026-06-12）：基于简历 / 基于 JD / 基于面经是**三种独立出题类型**，不是"面到死"连播模式（该提法已废弃）。

| type | 种子来源 | 现状 | 需新建 |
|---|---|---|---|
| `jd-topic` | campaign 拆 JD 话题清单 | ✅ 已闭环 | 无 |
| `resume-claim` | 简历拆解出的「声称会的点」 | ❌ 简历只是拆 JD 时的交叉参考 | ai-service `decompose_resume`（仿 jd_decompose.py：扁平点清单 + 重要度，无状态不入库）+ BFF 接线 |
| `report-seed` | 面经库种子（loopassist seeds） | ✅ 引擎已有，但只在模拟面试内 | campaign 侧接入：按战役岗位筛 seeds 进待练清单 |
| `review-item` | 失败账本复习项 | ✅ 已闭环 | 无（shell 的第四种调用方） |

**落点**：第 2 步随 PracticeShell 落地。campaign 覆盖度清单混排三种来源，UI 标注用大白话：**「JD 要的 / 简历说的 / 面经常考」**（界面禁内部术语）。排序按风险单维排（简历声称未验证 > JD core 未碰 > 已生疏），不掺剩余天数。

判分与回写规则沿用现有纪律：过线只标覆盖不写账本（碰过≠会），答崩写全局账本（同 handle 更新不重复建）。三种类型共用同一套锚点判分（/api/anchor-judge），无新判分逻辑。

---

## 5. 模拟面试的产品定位（用户裁决 ②）

模拟面试**不降级为参数档**，保持一级产品点：

- **入口不动**：首页/冲刺页的"开始模拟面试"入口保留甚至加强；`/learn?mode=interview` 路由不变。
- **体验仪式保留**：setup（岗位/题量/简历/JD）→ 出题大纲 → 多轮面试 → 复盘报告的完整叙事是产品卖点，不砍。
- **换的是内核**：第 4 步只把面试循环的单轮「问→答→判」换成 PracticeShell（`streaming + adversarial: followup` 档），setup 向导和复盘报告原样保留，仅做壳内对接。
- **黑色品牌外壳**在第 4 步对接时换成主系视觉（这是顺带收益，体验结构不变）。

理解方式：模拟面试 = PracticeShell 的**多轮编排器 + 自己的开场与复盘仪式**，而不是又一份循环实现。

---

## 6. 实施步骤（每步全绿才提交，单独成 commit）

### 第 1 步 · 拆文件（零行为变更）✂️
- learn-workspace.js → 搬出 ReviewPracticeWorkspace 成 `practice/review-practice.js`；抽 `practice/practice-result.js`，复习练先用。
- learn/page.js 改 import 路径；样式 class 名不动（CSS 零改动）。
- **验收**：全量 e2e 全绿 + `npm test` 全绿；learn-workspace.js 行数 4634 → ~4100。
- 风险：低。纯搬运。

### 第 2 步 · PracticeShell + 三种出题类型 🎯
- 建 `practice-shell.js`；ReviewPracticeWorkspace 与 campaign TopicPracticeView 改为调 shell（各自保留业务回调）。
- ai-service 加 `decompose_resume` + `/api/campaign/decompose-resume`；BFF campaign 创建/详情支持简历源话题；campaign 接 loopassist seeds 为面经源。
- campaign 清单按 §4 混排 + 来源标注 + 风险排序；建战役表单加「贴简历（可选）」——能复用 profile resume-versions 的就不新增上传。
- **验收**：campaign.pw / home-reading-memory e2e 扩断言后全绿；`decompose_resume` 加 pytest（仿 test_review_question.py）；真 LLM 手测一轮拆简历质量。
- 风险：中。campaign 清单数据结构要加 `source` 字段（store 兼容旧数据：缺省 = jd）。

### 第 3 步 · learn 训练模式接入 ⚠️ 风险最高，单独一刀
- 训练 thread 的单题循环（题面/作答/判分块）换 PracticeShell（开 streaming）；训练点 checkpoint 编排、进度栏、双栏阅读联动不动。
- **验收**：reading-companion / reentry-intents / focus-reading 全绿；手测一轮真 LLM 训练流。
- 回退：该步独立 commit，崩了 revert 不影响 1、2。

### 第 4 步 · 模拟面试对接（按 §5 定位）
- 面试循环单轮换 shell（`adversarial: followup` 档进 shell）；setup 向导与复盘报告保留，外壳换主系视觉。
- loopassist-workspace.js 预计 2373 → ~1200 行（循环与黑色外壳样式让位，向导+报告留下）。
- **验收**：loopassist.pw 全绿（断言随视觉换壳同步）+ 真 LLM 手测完整面试一场。

### 完成定义
- 四步合入后：练习循环实现只剩 PracticeShell 一份；`grep -rn "ll-thread-score-summary" frontend/components` 只命中 practice-result.js。
- 本文档删除，PLAN.md 第一阶段第 4 项划掉，learn-workspace 死代码清理（已登记 chip）可顺势执行。

---

## 7. 风险清单

| 风险 | 缓解 |
|---|---|
| learn-workspace 训练逻辑与阅读联动耦合深（第 3 步） | 只换循环渲染层，编排 state 不动；独立 commit 可整步 revert |
| campaign store 加 `source` 字段动持久化 | 读侧缺省兼容（无 source 视为 jd）；campaign-goal-store 单测补字段断言 |
| loopassist 流式协议与 learn 流式协议不一致 | shell 的 streaming 适配层以两边现有 payload 为准做归一，不改 BFF 协议 |
| 拆简历质量不可控（声称点拆得碎/泛） | 先真 LLM 手测调 prompt，质量不过关就降级为「简历整段作为出题上下文」，类型仍保留 |
| e2e 断言与视觉换壳互相牵扯（第 4 步） | 换壳与换内核同一刀内分两个 commit：先内核（断言不动）后换壳（只改断言） |
