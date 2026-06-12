# 收口计划

> 唯一在用的计划文档（2026-06-12 与用户对齐）。历史进度看 git log，产品原则看 [PRODUCT.md](../PRODUCT.md)，流程看 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 第一阶段：功能收尾 + 业务流程验收（进行中）

1. ~~修存量失败 e2e~~ ✅ 全量 42 过 0 失败（df4830a）
2. 出题类型补全：**基于简历 / 基于 JD / 基于面经**是三种独立出题类型（面经类型尚不存在；简历目前只在拆 JD 时交叉，不是独立类型）。方案先与用户对齐再动手
3. 逐页面走查验收：技术面已过（7 页零报错零失败请求）；交互手感待用户亲验；冲刺全路径补 e2e（campaign.pw.spec.js）
4. Practice 合并（learn-workspace + loopassist-workspace 合一）：先出方案（组件边界/路由/状态迁移）给用户确认，确认后单独一刀

## 第二阶段：UI 整体统一（前置：Practice 合并完成）

- design-system.css 收全量 token；learn 蓝 tint 家族收敛（6+ → 2）；语义三色写成明文规范（紫=训练、蓝=阅读、橙=面试）
- 验收：audit-dead-css 复跑 + 全量截图比对

## 第三阶段：代码/文档/测试精简 → 清洁版本

- capability-memory + src/mastery + memory-profile-store 链退役（首页已不渲染，BFF 还读，是关开关不是重写）
- learn-workspace 死代码（旧训练横幅 buildReadingTrainingBanner、缩放 changeReaderZoom 及死样式）
- 账本去重 / 陈旧项归档
- source-regex 型单测（正则匹配源码的）评估转行为测试
- 三件套文档对齐，全绿打 tag

## 明确不做 ⛔

- 时间压力做成设计点（压缩间隔、按剩余天数排序）：工具 push 不动用户。例外：next_due 被面试日期封顶（正确性，已做）
- "面到死"连播模式：已废弃的提法，按三种出题类型理解面试出题
- "系统记住了什么" / per-doc 掌握态一级页面（掌握只能是账本派生）
- 首页变回文档库 / 稍后读 backlog
- 预先把资料拆成完整概念图（失败驱动，不建模资料）
- 面试模式长出独立引擎/独立状态库
- 调度真设计（替换占位 next_due）：前置是真实使用数据，凭空调是浪费
