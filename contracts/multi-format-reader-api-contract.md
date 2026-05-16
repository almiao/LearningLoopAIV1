# Multi-Format Reader API Contract (V1)

Status: Draft
Date: 2026-05-07
Owner: Codex + product discussion

## Purpose

定义阅读页多格式资料的最小可实现 API 切面。

V1 目标：

1. 统一 `HTML/PDF/TXT/Markdown` 资料契约
2. 返回阅读渲染层和学习文本层
3. 保持对旧 `markdown` 契约的兼容

## Design Rules

1. `GET /api/knowledge/doc` 是阅读页单一文档入口。
2. 文档响应必须同时表达：
   - 原始载体
   - 阅读渲染
   - 学习文本
3. 原始文件访问和阅读渲染访问分开。
4. 兼容期保留 `markdown` 顶层字段。

## Shared Types

### `SourceDocumentV2`

```json
{
  "path": "materials/uuid",
  "title": "Redis Notes",
  "provider": "user-material",
  "providerLabel": "我的资料",
  "sourceType": "user-material",
  "primaryFormat": "html",
  "markdown": "# Redis Notes\n\nRedis persists data...",
  "source": {
    "kind": "remote-url",
    "mimeType": "text/html",
    "filename": "redis-notes.html",
    "url": "https://example.com/redis",
    "storedAssetPath": "materials/uuid/source/original.html",
    "snapshotAvailable": true,
    "snapshotCapturedAt": "2026-05-07T10:00:00Z",
    "byteSize": 120483
  },
  "render": {
    "format": "html",
    "viewMode": "sanitized-html",
    "defaultView": "original",
    "previewable": true,
    "viewUrl": "/api/materials/render?userId=user-1&path=materials%2Fuuid",
    "fallbackUrl": "/api/materials/original?userId=user-1&path=materials%2Fuuid",
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
    "extractionStatus": "ready",
    "extractionNotes": ""
  },
  "originalSource": {
    "kind": "remote-document",
    "url": "https://example.com/redis",
    "viewUrl": "/api/materials/render?userId=user-1&path=materials%2Fuuid",
    "filename": "redis-notes.html",
    "mimeType": "text/html",
    "previewable": true
  },
  "sourceRefs": [
    {
      "path": "materials/uuid",
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

### `render.format`

Allowed values:

1. `markdown`
2. `text`
3. `html`
4. `pdf`
5. `audio`
6. `video`
7. `unsupported`

### `render.viewMode`

Allowed values:

1. `markdown`
2. `text`
3. `sanitized-html`
4. `pdf`
5. `media-player`
6. `external`

### `learning.extractionStatus`

Allowed values:

1. `pending`
2. `ready`
3. `failed`
4. `unavailable`

## `GET /api/knowledge/doc`

Purpose:

1. 返回阅读页完整文档对象
2. 让前端根据 `render` 决定怎么展示
3. 让训练和问答根据 `learning` 决定怎么消费

Query:

```text
userId=<user-id>&path=<doc-path>
```

Response example: HTML material

```json
{
  "path": "materials/4f2a1111-2222-4333-8444-555566667777",
  "title": "Redis Notes",
  "provider": "user-material",
  "providerLabel": "我的资料",
  "sourceType": "user-material",
  "primaryFormat": "html",
  "markdown": "# Redis Notes\n\nRedis persists data using RDB snapshots and AOF logs.",
  "source": {
    "kind": "remote-url",
    "mimeType": "text/html",
    "filename": "redis-notes.html",
    "url": "https://example.com/redis",
    "storedAssetPath": "materials/4f2a.../source/original.html",
    "snapshotAvailable": true,
    "snapshotCapturedAt": "2026-05-07T10:00:00Z",
    "byteSize": 120483
  },
  "render": {
    "format": "html",
    "viewMode": "sanitized-html",
    "defaultView": "original",
    "previewable": true,
    "viewUrl": "/api/materials/render?userId=user-1&path=materials%2F4f2a1111-2222-4333-8444-555566667777",
    "fallbackUrl": "/api/materials/original?userId=user-1&path=materials%2F4f2a1111-2222-4333-8444-555566667777",
    "capabilities": {
      "outline": true,
      "findInPage": true,
      "pageJump": false,
      "timeSeek": false
    }
  },
  "learning": {
    "text": "Redis persists data using RDB snapshots and AOF logs. Replication improves availability.",
    "markdown": "# Redis Notes\n\nRedis persists data using RDB snapshots and AOF logs.\n\nReplication improves availability.",
    "outline": [
      { "id": "redis", "label": "Redis", "level": 1 }
    ],
    "chunkCount": 4,
    "sufficientForQa": true,
    "sufficientForTraining": true,
    "extractionStatus": "ready",
    "extractionNotes": ""
  }
}
```

Response example: PDF material

```json
{
  "path": "materials/7c9a1111-2222-4333-8444-555566667777",
  "title": "mysql-logs",
  "provider": "user-material",
  "providerLabel": "我的资料",
  "sourceType": "user-material",
  "primaryFormat": "pdf",
  "markdown": "# mysql-logs\n\nRedo log ...",
  "source": {
    "kind": "uploaded-file",
    "mimeType": "application/pdf",
    "filename": "mysql-logs.pdf",
    "url": "",
    "storedAssetPath": "materials/7c9a.../source/original.pdf",
    "snapshotAvailable": true,
    "snapshotCapturedAt": "2026-05-07T10:10:00Z",
    "byteSize": 801220
  },
  "render": {
    "format": "pdf",
    "viewMode": "pdf",
    "defaultView": "original",
    "previewable": true,
    "viewUrl": "/api/materials/original?userId=user-1&path=materials%2F7c9a1111-2222-4333-8444-555566667777",
    "fallbackUrl": "/api/materials/original?userId=user-1&path=materials%2F7c9a1111-2222-4333-8444-555566667777",
    "capabilities": {
      "outline": false,
      "findInPage": true,
      "pageJump": true,
      "timeSeek": false
    }
  },
  "learning": {
    "text": "Redo log is used for crash recovery...",
    "markdown": "# mysql-logs\n\nRedo log is used for crash recovery...",
    "outline": [],
    "chunkCount": 10,
    "sufficientForQa": true,
    "sufficientForTraining": true,
    "extractionStatus": "ready",
    "extractionNotes": ""
  }
}
```

Compatibility requirements:

1. 若历史文档无 `source/render/learning`
   - 必须至少返回：
     - `markdown`
     - `originalSource`
2. BFF 可在运行时补出：
   - `primaryFormat = markdown`
   - `render.format = markdown`
   - `render.viewMode = markdown`
   - `learning.markdown = markdown`

## `GET /api/materials/render`

Purpose:

返回适合阅读页内嵌展示的渲染资源。

V1 只对 `html` 提供独立渲染端点。

### HTML behavior

If `render.viewMode = sanitized-html`:

1. 返回安全副本 HTML
2. `Content-Type: text/html; charset=utf-8`
3. 建议加：
   - `Cache-Control: private, max-age=60`
   - `X-Frame-Options: SAMEORIGIN`
   - `Content-Security-Policy` 限制脚本和远程资源

Query:

```text
userId=<user-id>&path=<material-path>
```

Success response:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redis Notes</title>
  </head>
  <body>
    <article>
      <h1>Redis Notes</h1>
      <p>Redis persists data using RDB snapshots and AOF logs...</p>
    </article>
  </body>
</html>
```

Failure behavior:

1. If no renderable snapshot exists:
   - return `404` with JSON body
2. If format is not html:
   - return `409`

Failure response:

```json
{
  "error": "render_unavailable",
  "message": "HTML render snapshot is not available for this material."
}
```

## `GET /api/materials/original`

Purpose:

1. 返回原始文件
2. 或对远程原链接做受控重定向

Query:

```text
userId=<user-id>&path=<material-path>
```

Behavior:

1. `remote-url`
   - `302` redirect to original URL
2. `uploaded-file`
   - stream original bytes inline

Headers for uploaded file:

```text
Content-Type: application/pdf
Content-Disposition: inline; filename="mysql-logs.pdf"
```

## `POST /api/materials/ingest-url`

Purpose:

录入远程资料，并返回新资料对象。

Request:

```json
{
  "userId": "user-1",
  "url": "https://example.com/redis"
}
```

V1 behavior by content type:

1. `text/html`
   - save original HTML snapshot
   - generate sanitized render snapshot
   - extract `learning.text`
   - derive `learning.markdown`
2. `text/plain`
   - save original file
   - derive text and markdown
3. `text/markdown`
   - save original file
   - derive text from markdown
4. `application/pdf`
   - save original file
   - extract text and markdown

Response:

```json
{
  "material": {
    "path": "materials/uuid",
    "title": "Redis Notes",
    "primaryFormat": "html",
    "render": {
      "format": "html",
      "defaultView": "original",
      "previewable": true,
      "viewUrl": "/api/materials/render?userId=user-1&path=materials%2Fuuid"
    },
    "learning": {
      "extractionStatus": "ready",
      "sufficientForQa": true,
      "sufficientForTraining": true
    }
  }
}
```

## `POST /api/materials/upload`

Purpose:

录入本地文件，并返回新资料对象。

Request:

```json
{
  "userId": "user-1",
  "filename": "mysql-logs.pdf",
  "mimeType": "application/pdf",
  "contentBase64": "<base64>"
}
```

Response:

```json
{
  "material": {
    "path": "materials/uuid",
    "title": "mysql-logs",
    "primaryFormat": "pdf",
    "render": {
      "format": "pdf",
      "viewMode": "pdf",
      "defaultView": "original",
      "previewable": true,
      "viewUrl": "/api/materials/original?userId=user-1&path=materials%2Fuuid"
    },
    "learning": {
      "extractionStatus": "ready",
      "sufficientForQa": true,
      "sufficientForTraining": true
    }
  }
}
```

## `GET /api/materials`

Purpose:

列出用户资料卡片。

Response should include the minimum data needed for cards:

```json
{
  "materials": [
    {
      "path": "materials/uuid",
      "title": "Redis Notes",
      "sourceType": "user-material",
      "primaryFormat": "html",
      "render": {
        "format": "html",
        "defaultView": "original",
        "previewable": true
      },
      "learning": {
        "extractionStatus": "ready",
        "sufficientForQa": true,
        "sufficientForTraining": true
      },
      "originalSource": {
        "filename": "redis-notes.html",
        "mimeType": "text/html",
        "viewUrl": "/api/materials/render?userId=user-1&path=materials%2Fuuid"
      },
      "createdAt": "2026-05-07T10:00:00Z",
      "updatedAt": "2026-05-07T10:00:00Z"
    }
  ]
}
```

## Renderer Registry Interface

前端建议的渲染器映射：

```ts
type ReaderRendererId = "markdown" | "text" | "html" | "pdf" | "audio" | "video" | "unsupported";

type ReaderRendererRegistry = Record<ReaderRendererId, {
  supportsOriginalView: boolean;
  supportsLearningView: boolean;
  buildOutline: (doc: SourceDocumentV2) => OutlineItem[];
  renderOriginal: (doc: SourceDocumentV2) => ReactNode;
  renderLearning: (doc: SourceDocumentV2) => ReactNode;
}>;
```

V1 required mappings:

1. `markdown -> markdown renderer`
2. `text -> text renderer`
3. `html -> sanitized iframe renderer`
4. `pdf -> pdf frame renderer`
5. `unsupported -> fallback renderer`

## Migration Plan

### Migration Step 1: Contract Expansion

1. Keep old `markdown` top-level field
2. Add `primaryFormat`
3. Add `source`
4. Add `render`
5. Add `learning`

### Migration Step 2: Reader Upgrade

1. Frontend reads `render.format`
2. Old docs without `render` fall back to `markdown`

### Migration Step 3: AI Upgrade

1. `knowledge answer` reads `learning.text`
2. `training start` reads `learning.text`
3. `sufficient content` checks `learning.text`

### Migration Step 4: Historical Materials

Optional background migration:

1. Rename `document.md` to `learning.md`
2. Backfill `learning.txt`
3. Infer `primaryFormat`
4. Populate `render`

## Open Issues

1. HTML sanitization policy still needs exact allowlist definition.
2. PDF outline extraction is out of scope for V1.
3. Built-in JavaGuide docs may stay `markdown-first` initially, but should converge to the same contract.
