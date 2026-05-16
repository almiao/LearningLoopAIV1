import dynamic from "next/dynamic";

export const PdfReaderView = dynamic(
  () => import("./pdf-reader-view-client").then((module) => module.PdfReaderViewClient),
  {
    ssr: false,
    loading: () => (
      <article className="document-surface original-source-surface pdf-reader-shell" data-testid="original-source-surface">
        <section className="pdf-stage pdf-stage-loading" data-testid="pdf-stage">
          <div className="pdf-reader-loading">正在准备 PDF 阅读器…</div>
        </section>
      </article>
    ),
  },
);
