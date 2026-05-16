"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiFetch, buildApiUrl, postJson } from "../lib/api";
import { getReaderRenderer } from "../lib/document-reader-renderers";
import { getStoredUserId } from "../lib/user-session";

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",").at(-1) : value);
    };
    reader.onerror = () => reject(new Error("文件读取失败。"));
    reader.readAsDataURL(file);
  });
}

function formatSourceType(sourceType = "") {
  if (sourceType === "remote-url" || sourceType === "remote-document") {
    return "远程链接";
  }
  if (sourceType === "uploaded-file") {
    return "本地文件";
  }
  if (sourceType === "video-url") {
    return "视频链接";
  }
  return sourceType || "资料";
}

function formatPrimaryFormat(format = "") {
  if (format === "html") {
    return "HTML";
  }
  if (format === "pdf") {
    return "PDF";
  }
  if (format === "text") {
    return "TXT";
  }
  if (format === "markdown") {
    return "Markdown";
  }
  return format || "资料";
}

function isLikelyMaterialUrl(value = "") {
  try {
    const parsedUrl = new URL(String(value || "").trim());
    return (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") && parsedUrl.hostname.includes(".");
  } catch {
    return false;
  }
}

export function MaterialIngestionPage() {
  const fileInputRef = useRef(null);
  const submittedUrlRef = useRef("");
  const [userId, setUserId] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function refreshMaterials(nextUserId = userId) {
    if (!nextUserId) {
      return;
    }
    const data = await apiFetch(`/api/materials?userId=${encodeURIComponent(nextUserId)}`);
    setMaterials(data.materials || []);
  }

  useEffect(() => {
    const storedUserId = getStoredUserId();
    setUserId(storedUserId || "");
    if (storedUserId) {
      void refreshMaterials(storedUserId).catch(() => {});
    }
  }, []);

  async function ingestUrlValue(rawUrl = url) {
    const nextUrl = String(rawUrl || "").trim();
    if (!userId) {
      setError("请先在首页登录，再录入资料。");
      return;
    }
    if (!nextUrl || !isLikelyMaterialUrl(nextUrl) || submittedUrlRef.current === nextUrl) {
      return;
    }
    try {
      setLoading(true);
      setError("");
      submittedUrlRef.current = nextUrl;
      const data = await postJson("/api/materials/ingest-url", { userId, url: nextUrl });
      setResult(data.material);
      setUrl("");
      setFile(null);
      await refreshMaterials(userId);
    } catch (nextError) {
      submittedUrlRef.current = "";
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  async function uploadSelectedFile(nextFile) {
    if (!userId) {
      setError("请先在首页登录，再上传资料。");
      return;
    }
    if (!nextFile) {
      return;
    }
    try {
      setLoading(true);
      setError("");
      setFile(nextFile);
      setUrl("");
      const data = await postJson("/api/materials/upload", {
        userId,
        filename: nextFile.name,
        mimeType: nextFile.type || "application/octet-stream",
        contentBase64: await readFileAsBase64(nextFile),
      });
      setResult(data.material);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await refreshMaterials(userId);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setLoading(false);
    }
  }

  const previewRenderer = result ? getReaderRenderer(result) : null;
  const previewFormat = formatPrimaryFormat(result?.primaryFormat || result?.render?.format || "");
  const originalUrl = result?.render?.fallbackUrl || result?.originalSource?.viewUrl || result?.originalSource?.url || "";

  return (
    <main className="materials-shell">
      <header className="materials-topbar">
        <div className="materials-title-group">
          <Link className="back-link header-back-link" href="/">‹</Link>
          <div>
            <p className="eyebrow">资料录入</p>
            <h1>上传资料</h1>
          </div>
        </div>
        {materials.length ? (
          <Link className="secondary-pill materials-history-link" href={`/learn?doc=${encodeURIComponent(materials[0].path)}`}>
            最近：{materials[0].title}
          </Link>
        ) : null}
      </header>

      {error ? <section className="feedback-banner error-banner">{error}</section> : null}

      <section className="materials-workbench">
        <aside className="material-ingest-panel">
          <form className="material-ingest-form" onSubmit={(event) => event.preventDefault()}>
            <label className="material-source-input">
              <span>资料</span>
              <div className="material-input-row">
                <input
                  type="url"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    if (event.target.value.trim()) {
                      setFile(null);
                    }
                  }}
                  onBlur={() => void ingestUrlValue()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void ingestUrlValue(event.currentTarget.value);
                    }
                  }}
                  onPaste={(event) => {
                    const pastedUrl = event.clipboardData.getData("text");
                    window.setTimeout(() => {
                      void ingestUrlValue(pastedUrl);
                    }, 0);
                  }}
                  placeholder="粘贴链接，或选择文件"
                  disabled={Boolean(file) || loading}
                />
                <label className={file ? "file-picker-button active" : "file-picker-button"}>
                  {loading && file ? "上传中" : file ? "已选文件" : "选择文件"}
                  <input
                    ref={fileInputRef}
                    type="file"
                    disabled={loading}
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] || null;
                      if (nextFile) {
                        void uploadSelectedFile(nextFile);
                      }
                    }}
                  />
                </label>
              </div>
            </label>

            {file ? (
              <div className="selected-material-file">
                <strong>{file.name}</strong>
                <span>{loading ? "上传中..." : "已选择"}</span>
              </div>
            ) : null}

            <div className="material-ingest-status" aria-live="polite">
              {loading ? "正在生成预览..." : "选择文件会自动预览。链接粘贴后按 Enter。"}
            </div>
          </form>

          {result ? (
            <section className="material-result-summary" aria-label="资料来源信息">
              <p className="eyebrow">当前预览</p>
              <h2>{result.title}</h2>
              <dl className="material-source-meta">
                <div>
                  <dt>来源</dt>
                  <dd>{formatSourceType(result.sourceType)}</dd>
                </div>
                <div>
                  <dt>格式</dt>
                  <dd>{previewFormat}</dd>
                </div>
                {result.originalSource?.filename ? (
                  <div>
                    <dt>文件</dt>
                    <dd>{result.originalSource.filename}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="material-actions">
                <Link className="primary-pill" href={`/learn?doc=${encodeURIComponent(result.path)}`}>
                  开始阅读
                </Link>
                {originalUrl ? (
                  <a className="secondary-pill" href={buildApiUrl(originalUrl)} target="_blank" rel="noreferrer">
                    打开原文
                  </a>
                ) : null}
              </div>
            </section>
          ) : null}
        </aside>

        <section className="material-preview-pane" aria-label="资料预览">
          <header className="material-preview-toolbar">
            <div>
              <p className="eyebrow">预览</p>
              <h2>{result ? result.title : "上传后在这里阅读"}</h2>
            </div>
          </header>

          <div className="material-reader-preview">
            {result && previewRenderer ? (
              previewRenderer.renderOriginal(result, { readerZoom: 100 })
            ) : (
              <article className="material-empty-preview">
                <h3>一个入口，一个预览。</h3>
                <p>PDF 会按原文渲染，Markdown/TXT 会按阅读页样式排版。能不能读，一眼就知道。</p>
              </article>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
