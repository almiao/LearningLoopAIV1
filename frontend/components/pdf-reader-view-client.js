"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect?.width || 0;
      setWidth(nextWidth);
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export function PdfReaderViewClient({
  fileUrl = "",
  readerZoom = 100,
}) {
  const [numPages, setNumPages] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [canvasRef, canvasWidth] = useElementWidth();
  const scrollRef = useRef(null);

  const pageList = useMemo(
    () => Array.from({ length: numPages }, (_, index) => index + 1),
    [numPages],
  );

  function handleDocumentLoadSuccess(pdf) {
    setNumPages(pdf.numPages || 0);
    setLoadError("");
  }

  function handleDocumentLoadError(error) {
    setLoadError(error?.message || "PDF 预览加载失败。");
  }

  const measuredCanvasWidth = canvasWidth > 0 ? canvasWidth : 1088;
  const readingColumnWidth = Math.max(320, Math.min(measuredCanvasWidth - 48, 1040));
  const zoomMultiplier = Number.isFinite(Number(readerZoom))
    ? Math.max(0.7, Math.min(2, Number(readerZoom) / 100))
    : 1;
  const mainPageWidth = readingColumnWidth > 0
    ? Math.max(320, Math.floor(readingColumnWidth * zoomMultiplier))
    : 320;
  const pageScale = mainPageWidth / 612;

  useEffect(() => {
    if (!scrollRef.current) {
      return;
    }
    const scrollBox = scrollRef.current;
    scrollBox.scrollLeft = Math.max(0, (scrollBox.scrollWidth - scrollBox.clientWidth) / 2);
  }, [mainPageWidth, numPages]);

  return (
    <article className="document-surface original-source-surface pdf-reader-shell" data-testid="original-source-surface">
      <div className="pdf-reader-workbench">
        <Document
          file={fileUrl}
          loading={<div className="pdf-reader-loading">正在加载 PDF…</div>}
          onLoadSuccess={handleDocumentLoadSuccess}
          onLoadError={handleDocumentLoadError}
          error={<div className="pdf-reader-error">PDF 预览加载失败，请尝试“打开原文”。</div>}
          className="pdf-reader-document"
        >
          <section className="pdf-stage" data-testid="pdf-stage">
            {loadError ? (
              <div className="pdf-reader-error">{loadError}</div>
            ) : null}

            <div className="pdf-canvas-stage" ref={canvasRef}>
              <div className="pdf-canvas-scroll" ref={scrollRef}>
                <div className="pdf-page-stack">
                  {pageList.map((page) => (
                    <section key={page} className="pdf-page-section">
                      {pageList.length > 1 ? <div className="pdf-page-meta">第 {page} 页</div> : null}
                      <div className="pdf-canvas-paper">
                        <Page
                          pageNumber={page}
                          scale={pageScale}
                          renderAnnotationLayer={false}
                          renderTextLayer={false}
                        />
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </Document>
      </div>
    </article>
  );
}
