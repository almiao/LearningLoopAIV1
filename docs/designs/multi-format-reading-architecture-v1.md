# Multi-Format Reading Architecture V1

Status: Proposed
Date: 2026-05-07
Owner: Codex + product discussion

## Summary

阅读页不再把 `markdown` 当成唯一文档形态。

V1 正式把阅读链路拆成三层：

1. `source`
   原始资料载体，保留原文件、原链接、原始格式。
2. `render`
   面向阅读页的渲染层，决定用户在前台看到什么。
3. `learning`
   面向模型、训练、问答的标准文本层，决定 AI 吃什么。

第一阶段支持四种格式：

1. `html`
2. `pdf`
3. `text/plain`
4. `text/markdown`

这不是“给 HTML 开一个 iframe 例外”。

这是把系统从“单格式 markdown 阅读器”升级成“多格式阅读器 + 学习文本抽取管线”。

## Problem

当前系统默认假设“文档 = markdown”。

这个假设在几个地方已经开始成为产品瓶颈：

1. 阅读体验被 markdown 限制
   HTML 原文的目录、表格、交互块、代码高亮、锚点结构都丢了。
2. 原始载体和学习文本耦合
   现在为了给模型提供文本，连阅读页也被迫走 markdown。
3. 原文预览只是半成品
   现有“原文”模式主要是 `iframe` 外链，很多站点会因为 `X-Frame-Options` 或 CSP 拒绝嵌入。
4. 后续格式扩展会越来越乱
   如果继续靠 `if mimeType then markdown else iframe`，PDF、视频、音频一进来就会失控。

## Product Goal

V1 的目标很明确：

1. 对 `HTML/PDF/TXT/Markdown` 提供正式阅读支持。
2. 用户阅读尽量保留原始格式体验。
3. 模型问答和训练不再依赖“用户看到的是 markdown”这个前提。
4. 为后续 `audio/video` 接入留下稳定扩展面。

## Non-Goals

V1 不做这些：

1. 不做所有历史资料的一次性全量迁移重建。
2. 不做视频、音频播放器和转写能力的正式上线。
3. 不做通用 Office 文档渲染。
4. 不做网页浏览器级功能，比如登录态、表单提交、复杂脚本执行。

## Users and Jobs

### User Job 1: 阅读原始资料

用户希望：

1. 粘一个网页链接后，看到接近原始网页的阅读效果
2. 上传一个 PDF 后，直接翻页看，而不是看被压扁的纯文本
3. 读 TXT/Markdown 时，用稳定干净的文本视图

### User Job 2: 对资料发问和训练

用户希望：

1. 问答和训练能基于资料内容正常工作
2. 不需要理解“原文”和“学习版”的技术区别
3. 当某种格式不适合训练时，系统能清楚告诉他为什么

## Product Principles

1. 原始载体优先保真，学习文本优先可解析。
2. 阅读体验和模型体验分层，不互相绑架。
3. 每种格式都走统一契约，不再散落在页面条件分支里。
4. 优先 same-origin 预览，尽量减少跨站 iframe 失败率。
5. 明确降级路径，不能“预览失败就一片空白”。

## Current System Diagnosis

当前问题不是一个点，是一条链：

1. 资料录入层会把 HTML 直接转成 markdown 学习文档。
2. 存储层要求用户资料必须有 `document.md`。
3. 阅读页主视图默认只渲染 `knowledgeDoc.markdown`。
4. 训练、问答、内容充分性判断都直接读取 `document.markdown`。

结果就是：

1. 只要模型要文本，UI 就被迫 markdown 化。
2. 只要阅读要保真，训练链路就会担心“没有 markdown 怎么办”。

这两个目标本来就不该共用一份字段。

## Proposed Architecture

### 1. Unified Document Contract

所有可阅读资料统一返回一个 `SourceDocumentV2`。

```json
{
  "path": "materials/4f2a...",
  "title": "Redis Notes",
  "provider": "user-material",
  "providerLabel": "我的资料",
  "sourceType": "user-material",
  "primaryFormat": "html",
  "source": {
    "kind": "remote-url",
    "mimeType": "text/html",
    "filename": "redis-notes.html",
    "url": "https://example.com/redis",
    "storedAssetPath": "materials/4f2a/source/original.html",
    "snapshotAvailable": true,
    "snapshotCapturedAt": "2026-05-07T10:00:00Z"
  },
  "render": {
    "format": "html",
    "viewMode": "sanitized-html",
    "defaultView": "original",
    "previewable": true,
    "viewUrl": "/api/materials/render?userId=u1&path=materials%2F4f2a...",
    "fallbackUrl": "/api/materials/original?userId=u1&path=materials%2F4f2a...",
    "capabilities": {
      "outline": true,
      "findInPage": true,
      "pageJump": false,
      "timeSeek": false
    }
  },
  "learning": {
    "text": "Redis persists data using RDB snapshots and AOF logs...",
    "markdown": "# Redis Notes\n\nRedis persists data...",
    "outline": [
      { "id": "persistence", "label": "Persistence", "level": 2 }
    ],
    "chunkCount": 8,
    "sufficientForQa": true,
    "sufficientForTraining": true,
    "extractionStatus": "ready"
  },
  "sourceRefs": [
    {
      "path": "materials/4f2a...",
      "title": "Redis Notes",
      "sourceType": "user-material",
      "provider": "user-material",
      "originalUrl": "https://example.com/redis",
      "originalMimeType": "text/html",
      "originalFilename": "redis-notes.html"
    }
  ]
}
```

### 2. Three-Layer Model

#### `source`

原始资料信息，只回答“它是什么，从哪里来”。

字段：

1. `kind`
   `built-in-document | uploaded-file | remote-url`
2. `mimeType`
3. `filename`
4. `url`
5. `storedAssetPath`
6. `snapshotAvailable`
7. `snapshotCapturedAt`
8. `byteSize`

#### `render`

阅读页信息，只回答“怎么给用户看”。

字段：

1. `format`
   `markdown | text | html | pdf | audio | video | unsupported`
2. `viewMode`
   `markdown | text | sanitized-html | pdf | media-player | external`
3. `defaultView`
   `original | learning`
4. `previewable`
5. `viewUrl`
6. `fallbackUrl`
7. `capabilities`
   - `outline`
   - `findInPage`
   - `pageJump`
   - `timeSeek`

#### `learning`

模型和训练信息，只回答“AI 应该吃什么”。

字段：

1. `text`
2. `markdown`
3. `outline`
4. `chunkCount`
5. `sufficientForQa`
6. `sufficientForTraining`
7. `extractionStatus`
   `pending | ready | failed | unavailable`
8. `extractionNotes`

### 3. Renderer Registry

阅读页不再直接写死 `if markdown else iframe`。

引入渲染器注册表：

```ts
type ReaderRenderer = {
  id: "markdown" | "text" | "html" | "pdf" | "audio" | "video" | "unsupported";
  match(document: SourceDocumentV2): boolean;
  renderSurface(document: SourceDocumentV2): ReactNode;
  buildOutline(document: SourceDocumentV2): OutlineItem[];
  supportsLearningView(document: SourceDocumentV2): boolean;
  supportsOriginalView(document: SourceDocumentV2): boolean;
};
```

初始注册表：

1. `markdownRenderer`
2. `textRenderer`
3. `htmlRenderer`
4. `pdfRenderer`
5. `unsupportedRenderer`

### 4. Default View Rules

不同格式默认打开的视图不同：

| Format | Default View | Secondary View |
| --- | --- | --- |
| `html` | 原文 | 学习版 |
| `pdf` | 原文 | 学习版 |
| `text/plain` | 原文 | 学习版 |
| `text/markdown` | 学习版 | 原文 |

理由：

1. `html/pdf` 的主要价值是原始阅读体验。
2. `txt` 虽然原始和学习版接近，但仍保留双视图契约，减少特殊分支。
3. `markdown` 原生已经是学习友好格式，默认学习版最自然。

### 5. HTML Rendering Strategy

HTML 不能只靠跨站 iframe。

V1 采用双轨策略：

1. 优先渲染 same-origin 安全副本
   - 录入时抓取原始 HTML
   - 清洗危险标签、脚本、事件属性
   - 产出一个 same-origin 可嵌入阅读副本
2. 若安全副本不存在
   - 回退到远程原链接
   - 若远程链接拒绝嵌入，显示“打开原文”而不是白屏

设计原则：

1. 阅读层允许保留结构，不允许执行第三方脚本
2. 不在主页面 DOM 直接注入第三方 HTML
3. 使用 sandbox iframe 承载安全副本

### 6. PDF Rendering Strategy

PDF 走浏览器内嵌预览：

1. `viewMode = pdf`
2. `viewUrl = /api/materials/original?...`
3. 阅读页使用内嵌 PDF frame
4. 学习文本来自单独抽取

### 7. TXT / Markdown Rendering Strategy

这两类走文本阅读器：

1. `text/plain`
   - 原文视图显示等宽或阅读排版文本
   - 学习版显示标准化 markdown / paragraph blocks
2. `text/markdown`
   - 学习版沿用现有 markdown 渲染器
   - 原文视图可以显示 raw markdown 或接近原始文本的阅读模式

## Data Model Changes

### Material Metadata V2

用户资料元数据新增：

```json
{
  "id": "uuid",
  "userId": "user_1",
  "path": "materials/uuid",
  "title": "Redis Notes",
  "sourceType": "remote-document",
  "primaryFormat": "html",
  "source": {
    "kind": "remote-url",
    "url": "https://example.com/redis",
    "mimeType": "text/html",
    "filename": "redis-notes.html",
    "storedAssetFilename": "original.html",
    "snapshotAvailable": true
  },
  "render": {
    "format": "html",
    "viewMode": "sanitized-html",
    "defaultView": "original",
    "previewable": true
  },
  "learning": {
    "textFilename": "learning.txt",
    "markdownFilename": "learning.md",
    "outlineFilename": "outline.json",
    "extractionStatus": "ready",
    "sufficientForQa": true,
    "sufficientForTraining": true
  }
}
```

### Storage Layout

当前：

```text
materials/{id}/
  metadata.json
  document.md
  original.*
```

V1 目标：

```text
materials/{id}/
  metadata.json
  learning.md
  learning.txt
  outline.json
  original.html | original.pdf | original.txt | original.md
  rendered.html         # only for html sanitized snapshot
```

## Reader Page UX

### Reader Toolbar

阅读页顶部继续保留双视图，但语义升级：

1. `原文`
2. `学习版`
3. `目录`
4. `专注`

显示规则：

1. 如果 `render.previewable = true`，显示 `原文`
2. 如果 `learning.extractionStatus = ready`，显示 `学习版`
3. 两者都没有时，展示降级状态说明

### Reading Surface Wireframe

```text
+--------------------------------------------------------------+
| 标题                                  [原文] [学习版] [目录] |
+--------------------------------------------------------------+
| 来源: HTML · 已生成学习版 · 可问答                            |
|--------------------------------------------------------------|
|                                                              |
|  原文模式                                                    |
|  +--------------------------------------------------------+  |
|  | sandbox iframe / pdf frame / text viewer              |  |
|  |                                                        |  |
|  +--------------------------------------------------------+  |
|                                                              |
+--------------------------------------------------------------+
| 右侧 QA / 训练面板                                           |
+--------------------------------------------------------------+
```

学习版模式：

```text
+--------------------------------------------------------------+
| 标题                                  [原文] [学习版] [目录] |
+--------------------------------------------------------------+
| 来源: HTML · 学习抽取文本                                    |
|--------------------------------------------------------------|
|                                                              |
|  # Redis Notes                                               |
|                                                              |
|  Redis persists data using RDB snapshots and AOF logs...     |
|                                                              |
|  ## Persistence                                              |
|  ...                                                         |
|                                                              |
+--------------------------------------------------------------+
| 右侧 QA / 训练面板                                           |
+--------------------------------------------------------------+
```

### Ingestion Result Card Wireframe

```text
+--------------------------------------------------------------+
| 录入完成                                                     |
| Redis Notes                                                  |
| 来源类型: 远程链接  原始格式: text/html                      |
|--------------------------------------------------------------|
| [预览原文] [查看学习版] [开始学习]                           |
|--------------------------------------------------------------|
| 原文预览 / 学习版预览                                        |
+--------------------------------------------------------------+
```

## API Shape

接口详细 JSON 草案单独写到：

[`contracts/multi-format-reader-api-contract.md`](/Users/lee/IdeaProjects/LearningLoopAIV1/contracts/multi-format-reader-api-contract.md)

这里先给最重要的边界：

1. `GET /api/knowledge/doc`
   返回 `SourceDocumentV2`
2. `GET /api/materials/render`
   返回 HTML 安全副本或渲染资源
3. `GET /api/materials/original`
   返回原始文件或重定向
4. `POST /api/materials/ingest-url`
   返回新的多格式资料对象
5. `POST /api/materials/upload`
   返回新的多格式资料对象

## AI and Training Implications

这是本次改造里最容易被低估的一层。

### Rule 1

训练和问答不再依赖 `document.markdown`，改为优先读取：

1. `document.learning.text`
2. 如果为空，再降级到 `document.learning.markdown`

### Rule 2

内容充分性判断改为基于 `learning.text`，不再基于 `markdown` 行清洗。

### Rule 3

目录提取优先使用 `learning.outline`。

如果该字段缺失，再按格式降级：

1. `markdown` 从标题提取
2. `html` 从文档标题节点提取
3. `pdf` 暂无结构化 outline 时返回空
4. `txt` 可选按简单 heading heuristic 提取

## Migration Plan

### Phase 1

目标：正式支持 `HTML/PDF/TXT/Markdown` 阅读。

#### Backend

1. 扩展 `saveCustomMaterial`，允许保存 `source/render/learning` 三层结构
2. 保留兼容字段 `markdown`，其值映射到 `learning.markdown`
3. 新增 `learning.text` 和 `learning.outline`
4. 新增 `primaryFormat`
5. 新增 `GET /api/materials/render`

#### Frontend

1. 引入渲染器注册表
2. 阅读页根据 `render.format` 选 renderer
3. HTML 和 PDF 默认切到 `原文`
4. TXT 和 Markdown 支持双视图
5. 录入页改成原文/学习版双预览

#### AI

1. 问答接口切换到 `learning.text`
2. 训练入口切换到 `learning.text`
3. 内容充分性判断切换到 `learning.text`

### Phase 2

目标：补齐 `audio/video` 所需契约，但先不上线完整体验。

1. 扩展 `render.format = audio | video`
2. 增加 `timeSeek` 能力位
3. `learning.text` 改为可承载 transcript

### Phase 3

目标：离线重建历史资料。

1. 补写迁移脚本
2. 把老 `document.md` 迁到 `learning.md`
3. 尽可能恢复 `learning.txt`
4. 为 HTML 历史资料补安全副本

## Compatibility Rules

V1 过渡期保留这些兼容规则：

1. 若返回对象仍只有 `markdown`
   - 前端视为 `render.format = markdown`
   - `learning.markdown = markdown`
2. 若没有 `learning.text`
   - 问答和训练降级到 `learning.markdown || markdown`
3. 若没有 `render`
   - 阅读页走旧逻辑，但记录降级状态

## Open Questions

1. HTML 安全副本是否允许保留站内样式表，还是统一转极简阅读样式？
2. PDF 是否需要引入更强的页码和定位能力，还是先满足内嵌预览？
3. 历史资料迁移是否需要异步后台任务队列？
4. 是否要把 built-in JavaGuide 文档也迁到同一份 `SourceDocumentV2` 契约？

## Recommended Implementation Order

1. 先改文档契约和 BFF 响应
2. 再改阅读页 renderer registry
3. 再迁训练/问答到 `learning.text`
4. 最后改录入页和历史资料迁移

## Why This Is The Right Scope

这版范围够完整，但还没失控。

它是一片“湖”，不是“海”：

1. 只覆盖 4 种格式
2. 只重构阅读与学习文本边界
3. 不引入浏览器级复杂度
4. 不把未来音视频问题硬塞进这次交付

这就是 V1 应该做的事。
