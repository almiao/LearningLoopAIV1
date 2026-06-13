import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("home page is a single-column act-led view; library lives on its own secondary page", async () => {
  const source = await readFile(`${root}/frontend/components/home-page.js`, "utf8");
  const librarySource = await readFile(`${root}/frontend/components/library/library-workspace.js`, "utf8");
  const libraryShared = await readFile(`${root}/frontend/components/library/shared.js`, "utf8");
  const libraryRoute = await readFile(`${root}/frontend/app/library/page.js`, "utf8");
  const documentRouteSource = await readFile(`${root}/frontend/app/documents/[slug]/page.js`, "utf8");
  const learnSource = await readFile(`${root}/frontend/components/learn-workspace.js`, "utf8");
  const styles = await readFile(`${root}/frontend/app/globals.css`, "utf8");

  // 首页：单栏 act-led，三行清单（接着学 / 学新的 / 补复习），不再承载资料树或登录门槛。
  assert.match(source, /ensureLocalUserProfile/);
  assert.match(source, /buildReentryPlan/);
  assert.match(source, /今天从这里推进/);
  assert.match(source, /接着学/);
  assert.match(source, /学点新的/);
  assert.match(source, /补今天到期的复习/);
  assert.doesNotMatch(source, /扩展资料库/);
  assert.doesNotMatch(source, /三件事互不依赖/);
  assert.match(source, /开始读这篇/);
  assert.doesNotMatch(source, /打开候选材料/);
  assert.doesNotMatch(source, /未读完正文/);
  assert.doesNotMatch(source, /今日无复习/);
  assert.match(source, /设置面试日期/);
  assert.match(source, /添加新材料/);
  assert.match(source, /今天先不练这个/);
  assert.match(source, /今天先不读这个/);
  assert.match(source, /面试冲刺/);
  assert.match(source, /本机档案/);
  assert.doesNotMatch(source, /LoginModal/);
  assert.doesNotMatch(source, /登录 \/ 创建账号/);
  assert.doesNotMatch(source, /isLoggedIn=\{Boolean\(profile\?\.user\?\.id\)\}/);
  assert.match(source, /href="\/library"/);
  assert.match(source, /href="\/materials"/);
  assert.match(source, /ll-home-main/);
  // 旧资料库深链迁移。
  assert.match(source, /searchParams\.get\("mode"\) === "library"/);
  assert.match(source, /router\.replace\("\/library"\)/);
  // 资料树/库浏览器不再出现在首页。
  assert.doesNotMatch(source, /LibraryTreeNode/);
  assert.doesNotMatch(source, /LibraryBrowser/);
  assert.doesNotMatch(source, /ll-sidebar/);
  assert.doesNotMatch(source, /ll-workspace/);
  assert.doesNotMatch(source, /搜索资料/);
  assert.doesNotMatch(source, /打开阅读页/);
  assert.doesNotMatch(source, /buildDetailHref/);
  assert.doesNotMatch(source, /查看准备页/);
  assert.doesNotMatch(source, /Anthropic: Engineering Context for Claude/);

  // /library 二级页：树导航 + 层级浏览 + 管理（忽略）收编于此。
  assert.match(libraryRoute, /LibraryWorkspace/);
  assert.match(librarySource, /LibraryTreeNode/);
  assert.match(librarySource, /LibraryBrowser/);
  assert.match(librarySource, /FolderAggregateBar/);
  assert.match(librarySource, /includeIgnoredDocuments/);
  assert.match(librarySource, /包含忽略文档/);
  assert.match(librarySource, /ll-library-ignore-button/);
  assert.match(librarySource, /onToggleIgnored/);
  assert.match(librarySource, /子文件夹/);
  assert.match(librarySource, /当前层级文档/);
  assert.match(librarySource, /我的资料 \/ /);
  assert.match(librarySource, /搜索资料/);
  assert.match(librarySource, /添加材料/);
  assert.match(librarySource, /返回首页/);

  // 资料域共享派生只有一份，首页与二级页共用。
  assert.match(libraryShared, /export function buildLibraryTree/);
  assert.match(libraryShared, /export function flattenLibrarySegments/);
  assert.match(libraryShared, /export function buildSidebarDocument/);
  assert.match(libraryShared, /export function getDocumentGroup/);

  assert.match(documentRouteSource, /redirect\(`\/learn/);
  assert.doesNotMatch(documentRouteSource, /DocumentPrepPage/);

  assert.match(learnSource, /TrainingWorkspace/);
  assert.match(learnSource, /RescuePlaylistStrip/);
  assert.match(learnSource, /TrainingCompletionSummaryPage/);
  assert.match(learnSource, /ReadingDocumentContent/);
  assert.match(learnSource, /ReadingSelectionPopover/);
  assert.match(learnSource, /ReadingAssistantBubble/);
  assert.match(learnSource, /ReadingReentryCard/);
  assert.match(learnSource, /继续上次训练/);
  assert.match(learnSource, /visibleReadProgressPercent/);
  assert.match(learnSource, /toggleIgnoredDocument/);
  assert.match(learnSource, /标记为忽略/);
  assert.match(learnSource, /标记为仅阅读完成/);
  assert.doesNotMatch(learnSource, /搁置/);
  assert.doesNotMatch(learnSource, /reader-mastery-pill/);
  assert.doesNotMatch(learnSource, /document-completion-card/);
  assert.match(learnSource, /问任何关于这篇的问题/);
  assert.match(learnSource, /reading-composer-starters/);
  assert.match(learnSource, /normalizeAssistantMarkdown/);
  assert.doesNotMatch(learnSource, /12 道题/);
  assert.doesNotMatch(learnSource, /buildReadingTrainingBanner/);
  assert.doesNotMatch(learnSource, /readingTrainingBannerLabel/);
  assert.doesNotMatch(learnSource, /readingTrainingBannerClickable/);
  assert.doesNotMatch(learnSource, /reader-progress-track/);
  assert.doesNotMatch(learnSource, /is-read/);
  assert.doesNotMatch(learnSource, /is-unread/);
  assert.doesNotMatch(learnSource, /<p>\{entry\.body\}<\/p>/);
  assert.match(learnSource, /buildTrainingCompletionSummary/);

  assert.match(styles, /\.ll-home-main\s*\{/);
  assert.match(styles, /\.ll-library-nav-link\s*\{/);
  assert.match(styles, /\.ll-tree-shell\s*\{/);
  assert.match(styles, /\.ll-folder-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.ll-folder-progress\s*\{/);
  assert.match(styles, /\.ll-include-ignored-toggle\s*\{/);
  assert.match(styles, /\.ll-library-ignore-button\s*\{/);
  assert.match(styles, /\.ll-library-document-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.ll-breadcrumbs\s*\{/);
  assert.doesNotMatch(styles, /\.ll-today-review\s*\{/);
  assert.doesNotMatch(styles, /\.ll-prep-page\s*\{/);
  assert.doesNotMatch(styles, /\.ll-prep-stage\s*\{/);
  assert.doesNotMatch(styles, /\.ll-prep-popover\s*,\s*\.ll-prep-menu\s*\{/);
  assert.match(styles, /\.ll-training-page\s*\{/);
  assert.match(styles, /\.ll-score-card\s*,/);
  assert.match(styles, /\.ll-training-rail\s*\{/);
  assert.match(styles, /\.ll-training-summary-page\s*\{/);
  assert.match(styles, /\.ll-summary-hero\s*\{/);
  assert.match(styles, /\.ll-summary-score-blocks\s*\{/);
  assert.match(styles, /\.ll-summary-weak-card\s*\{/);
  assert.match(styles, /\.reading-document-surface\s*\{/);
  assert.match(styles, /\.reading-reentry-copy\s*\{/);
  assert.match(styles, /\.reading-code-block\s*\{/);
  assert.match(styles, /\.reading-training-banner\.tone-action\s*,/);
  assert.doesNotMatch(styles, /\.reader-mastery-pill\s*\{/);
  assert.doesNotMatch(styles, /\.document-completion-card\s*\{/);
  assert.doesNotMatch(styles, /\.reader-progress-track\s*\{/);
  assert.doesNotMatch(styles, /\.reading-paragraph\.is-read\s*\{/);
  assert.doesNotMatch(styles, /\.reading-paragraph\.is-unread\s*\{/);
  assert.match(styles, /\.reading-selection-popover\s*\{/);
  assert.match(styles, /\.reading-ai-message\s*\{/);
});
