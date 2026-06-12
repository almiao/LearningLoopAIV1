import { expect, test } from "@playwright/test";

const bffPort = process.env.E2E_BFF_PORT || "14100";
const bffBaseUrl = `http://127.0.0.1:${bffPort}`;
const mockUserId = "pdf_layout_user";
const mockDocPath = "materials/mock-pdf-layout";
const apiBaseUrls = Array.from(new Set([bffBaseUrl, "http://127.0.0.1:4000"]));

function escapePdfText(value = "") {
  return String(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function buildMockPdfBuffer(lines = []) {
  const safeLines = lines.length ? lines : ["Mock PDF Layout"];
  const contentStream = [
    "BT",
    "/F1 20 Tf",
    "72 742 Td",
    ...safeLines.flatMap((line, index) => (
      index === 0
        ? [`(${escapePdfText(line)}) Tj`]
        : ["0 -28 Td", `(${escapePdfText(line)}) Tj`]
    )),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(contentStream, "utf8")} >>\nstream\n${contentStream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdfBody = "%PDF-1.4\n";
  const offsets = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdfBody, "utf8"));
    pdfBody += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdfBody, "utf8");
  pdfBody += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdfBody += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdfBody += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdfBody, "utf8");
}

test("pdf documents stay in the standard reader workspace instead of switching to a single-page layout", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Desktop split reader behavior is asserted on the desktop project.");

  const mockPdfBuffer = buildMockPdfBuffer([
    "PDF reader layout",
    "The PDF reader should stay inside the normal reading workspace.",
  ]);

  await page.addInitScript((storedUserId) => {
    window.localStorage.setItem("learning-loop-user-id", storedUserId);
  }, mockUserId);

  for (const apiBaseUrl of apiBaseUrls) {
    await page.route(`${apiBaseUrl}/api/knowledge/docs*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [
            {
              path: mockDocPath,
              title: "PDF 布局对齐样例",
            },
          ],
        }),
      });
    });

    await page.route(`${apiBaseUrl}/api/profile/${mockUserId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: mockUserId,
            handle: mockUserId,
          },
          documentProgress: {
            docs: {},
          },
        }),
      });
    });

    await page.route(`${apiBaseUrl}/api/profile/reading-progress`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
        }),
      });
    });

    await page.route(`${apiBaseUrl}/api/knowledge/doc?*`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("path") !== mockDocPath) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          path: mockDocPath,
          title: "PDF 布局对齐样例",
          primaryFormat: "pdf",
          render: {
            format: "pdf",
            previewable: true,
            viewUrl: "/qa/mock-pdf-layout.pdf",
            defaultView: "original",
          },
          originalSource: {
            url: "/qa/mock-pdf-layout.pdf",
            viewUrl: "/qa/mock-pdf-layout.pdf",
          },
          learning: {
            markdown: "# PDF 布局对齐样例\n\n这是一份用于阅读器布局回归测试的 PDF。",
            outline: [],
          },
        }),
      });
    });

    await page.route(`${apiBaseUrl}/qa/mock-pdf-layout.pdf`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "cache-control": "no-store",
        },
        body: mockPdfBuffer,
      });
    });
  }

  await page.goto(`/learn?doc=${encodeURIComponent(mockDocPath)}`, { waitUntil: "networkidle" });

  await expect(page.getByTestId("study-main")).not.toHaveClass(/single-page-reader-layout/);
  await expect(page.getByTestId("qa-panel")).toBeVisible();
  await expect(page.getByTestId("pdf-stage")).toBeVisible();
  await expect(page.locator(".react-pdf__Page__canvas").first()).toBeVisible();

  const widths = await page.evaluate(() => {
    const reader = document.querySelector("[data-testid='reader-panel']");
    const qa = document.querySelector("[data-testid='qa-panel']");
    if (!(reader instanceof HTMLElement) || !(qa instanceof HTMLElement)) {
      return {
        readerWidth: 0,
        qaWidth: 0,
      };
    }
    return {
      readerWidth: reader.getBoundingClientRect().width,
      qaWidth: qa.getBoundingClientRect().width,
    };
  });

  expect(widths.readerWidth).toBeGreaterThan(700);
  expect(widths.qaWidth).toBeGreaterThan(260);

  const initialCanvasWidth = await page.locator(".react-pdf__Page__canvas").first().evaluate((node) => node.getBoundingClientRect().width);
  expect(initialCanvasWidth).toBeGreaterThan(800);

  // 缩放工具条已从阅读器移除；这里只验证默认布局下画布不溢出阅读面板。
  const overflow = await page.evaluate(() => {
    const reader = document.querySelector("[data-testid='reader-panel']");
    const stage = document.querySelector(".pdf-canvas-stage");
    if (!(reader instanceof HTMLElement) || !(stage instanceof HTMLElement)) {
      return 0;
    }
    return stage.getBoundingClientRect().right - reader.getBoundingClientRect().right;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
