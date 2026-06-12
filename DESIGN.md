# LearningLoop 设计基准

全站唯一视觉基准。新页面、新组件、AI 生成的界面一律对照本文件；偏离本基准视为缺陷。
2026-06 UI 整合时定稿：以首页（暖纸 + 墨色 + 黑主按钮）为基准收敛全站，
原 library/materials 品牌紫、LoopAssist 橙色、旧冷灰系均已退役。

## 色彩

只允许使用 `frontend/app/globals.css` 中 `:root` 的 token，禁止新增硬编码色值。

| 角色 | Token | 值 |
|---|---|---|
| 页面底色 | `--paper-tint` / `--bg` | `#faf9f5` |
| 卡片底色 | `--paper` / `--surface` | `#ffffff` |
| 次级底色 | `--paper-warm` / `--surface-subtle` | `#f3f1ea` |
| 弱底色 | `--paper-soft` / `--surface-muted` | `#f1efe8` |
| 分隔线 | `--line-warm` / `--line` | `#e8e6dc` |
| 强分隔线 | `--line-strong` | `#d7d2c8` |
| 正文 | `--ink` / `--text` | `#191917` |
| 次级文字 | `--ink-2` / `--text-muted` | `#63635e` |
| 弱文字 | `--ink-3` / `--text-soft` | `#888780` |
| 主操作（按钮） | `--accent` | `#111111`（黑底白字） |
| 进度 / 成功 | `--green` `--green-deep` `--accent-green` | 绿系 |
| 面试相关强调 | `--danger` | `#cc4b37`（面试冲刺、LoopAssist 品牌色统一用它） |
| 警示 / 薄弱 | `--amber` | `#b9821a` |

历史遗留别名（`--bg`/`--surface`/`--text`/`--brand-purple` 等）已全部映射到上表值，
保留只为兼容存量类名；新代码直接用暖纸系 token。
`--brand-purple*` 现等于墨色系，不再是紫色，不要在新代码里使用。

## 字体

- 全站正文与 UI：`Inter` 栈（body 上已设，组件不要再覆盖 `font-family`）。
- LoopAssist 模拟面试间保留 `Fraunces`（展示标题）与 `JetBrains Mono`（计数/计时）作为
  刻意的"面试房间"氛围差异——这是唯一允许的字体例外。

## 部件规范

- **顶栏**：所有一级页面用 `ll-topbar` + `ll-brand`（方块标 + LearningLoop 字标），
  右侧动作用 `ll-secondary-button`；返回统一写"← 返回首页"。
  LoopAssist 保留自己的子品牌顶栏（产品决策：模拟面试是一级产品点）。
- **主按钮**：黑底白字圆角（`primary-pill` / `ll-*` 黑按钮），一个视图只有一个主按钮。
- **空态 / 拦截页**：`gate-card`（白卡 + 标题 + 一句说明 + 黑色主按钮），见 learn / profile。
- **状态徽标**：圆角胶囊（`ll-status-pill`），底色用弱底色系，语义色只用绿/红/琥珀。
- **卡片**：`ll-surface-card`（细线 + 软阴影），圆角用 `--ll-radius-*`（10/16/24px）。

## 规则

1. 新增颜色先问"能否用现有 token 表达"，不能就改这份文档再加 token。
2. 界面文案禁用内部术语（战役/drill/账本/锚点等），一律大白话。
3. 语义色固定：绿=进度/成功，红 `--danger`=面试强调与错误，琥珀=薄弱/警示；不要互换。
4. 每个视图一个焦点：一个主按钮、一个标题层级链（h1→h2 不跳级）。
