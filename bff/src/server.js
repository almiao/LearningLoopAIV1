import { convertRemoteMaterialUrl, convertUploadedMaterial } from "../../src/ingestion/material-converter.js";
import { listCustomMaterials, listSourceDocuments, readCustomMaterialOriginal, readCustomMaterialRender, readSourceAsset, readSourceDocument, saveCustomMaterial } from "../../src/knowledge/source-document-resolver.js";
import { buildLoopAssistOptions, previewLoopAssistScope } from "../../src/loopassist/corpus.js";
import http from "node:http";
import { buildMissingAssetPlaceholder, buildSafeContentDisposition, buildServiceBaseUrl, port, readJsonBody, sendBuffer, sendErrorJson, sendJson, withCorsHeaders } from "./lib/http-utils.js";
import { handleAnswer, handleAnswerStream, handleFocusConcept, handleFocusDomain, handleStartTarget, isCompletedDocumentSession, isResumableDocumentSession, stripSessionPayload } from "./lib/interview-domain.js";
import { handleKnowledgeAnswer } from "./lib/knowledge-domain.js";
import { handleLoopAssistStart, handleLoopAssistStream, recordLoopAssistDrillRounds } from "./lib/loopassist-domain.js";
import { buildProfilePayload, getUserProfile, handleIgnoredDocument, handleListResumeVersions, handleReadingProgress, handleRecommendationSnooze, handleSaveResumeVersion, handleSkippedTraining } from "./lib/profile-domain.js";
import { aiServiceUrl, proxyBinary, proxyJson, ttsServiceUrl } from "./lib/service-proxy.js";
import { rescuePlaylistStore, reviewItemStore, userProfileStore } from "./lib/stores.js";

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "OPTIONS") {
      withCorsHeaders(response, 204, { "content-type": "text/plain; charset=utf-8" });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, aiServiceUrl });
      return;
    }

    // Today Queue「今日复习」块（阶段 4 最小读出口）：账本按 next_due 渲染。
    if (request.method === "GET" && url.pathname === "/api/review/today") {
      const items = await reviewItemStore.listDue({});
      sendJson(response, 200, { items, count: items.length });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/loopassist/options") {
      sendJson(response, 200, buildLoopAssistOptions());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/preview-scope") {
      const body = await readJsonBody(request);
      sendJson(response, 200, previewLoopAssistScope(body.scope || body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/start") {
      sendJson(response, 200, await handleLoopAssistStart(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/answer") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/answer", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/answer-stream") {
      await handleLoopAssistStream(await readJsonBody(request), response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/review") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/review", await readJsonBody(request));
      recordLoopAssistDrillRounds(data);
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/review-question") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/review-question", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/review-summary") {
      const { data, traceId } = await proxyJson("POST", "/api/loopassist/review-summary", await readJsonBody(request));
      sendJson(response, 200, { ...data, traceId });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/rescue-playlist/prepare") {
      const body = await readJsonBody(request);
      const documents = await listSourceDocuments({ userId: body.userId || "" });
      sendJson(response, 200, {
        playlist: await rescuePlaylistStore.prepare({
          sessionId: body.sessionId,
          scope: body.scope || {},
          review: body.review || {},
          documents,
          generatePlan: async () => {
            const { data } = await proxyJson("POST", "/api/loopassist/rescue-plan", {
              scope: body.scope || {},
              review: body.review || {},
              documents,
            });
            return Array.isArray(data?.items) ? data.items : [];
          },
        }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/loopassist/rescue-playlist") {
      sendJson(response, 200, {
        playlist: await rescuePlaylistStore.get(url.searchParams.get("playlistId") || ""),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/rescue-playlist/learned") {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        playlist: await rescuePlaylistStore.markLearned({
          playlistId: body.playlistId,
          itemId: body.itemId,
        }),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/loopassist/rescue-playlist/document") {
      const playlistId = url.searchParams.get("playlistId") || "";
      const itemId = url.searchParams.get("itemId") || "";
      let payload = await rescuePlaylistStore.buildDocumentPayload({ playlistId, itemId });
      if (payload.needsMaterial) {
        const item = payload.item || {};
        const gap = {
          topic: item.topic || "",
          title: item.title || "",
          questionText: (item.sourceQuestionTexts || []).join(" / "),
          summary: item.summary || "",
          misses: item.misses || [],
          keyPoints: item.keyPoints || [],
          likelyFollowups: item.likelyFollowups || [],
        };
        const { data } = await proxyJson("POST", "/api/loopassist/rescue-material", {
          scope: {
            role: item.scopeRole || payload.playlist?.scope?.role || "",
            round: payload.playlist?.scope?.round || "",
          },
          gap,
        });
        const markdown = typeof data?.markdown === "string" ? data.markdown.trim() : "";
        if (!markdown) {
          throw new Error("AI 服务未能生成补救讲解，请稍后重试。");
        }
        await rescuePlaylistStore.saveMaterial({ playlistId, itemId, markdown });
        payload = await rescuePlaylistStore.buildDocumentPayload({ playlistId, itemId });
      }
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/loopassist/tts") {
      const result = await proxyBinary(ttsServiceUrl, "POST", "/api/tts", await readJsonBody(request));
      sendBuffer(response, 200, result.body, {
        "content-type": result.contentType,
        "x-trace-id": result.traceId,
        "x-loopassist-tts-provider": result.provider,
        "x-loopassist-tts-speaker": result.speaker,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const { user, created } = await userProfileStore.loginOrCreate({
        handle: body.handle,
        pin: body.pin,
      });
      sendJson(response, 200, {
        created,
        profile: await buildProfilePayload(user),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/profile/resume-versions") {
      const userId = url.searchParams.get("userId") || "";
      sendJson(response, 200, await handleListResumeVersions(userId));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/resume-versions") {
      sendJson(response, 200, await handleSaveResumeVersion(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/profile/")) {
      const userId = url.pathname.split("/").at(-1);
      sendJson(response, 200, await buildProfilePayload(await getUserProfile(userId)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/reading-progress") {
      sendJson(response, 200, await handleReadingProgress(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/ignored-document") {
      sendJson(response, 200, await handleIgnoredDocument(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/skipped-training") {
      sendJson(response, 200, await handleSkippedTraining(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/profile/recommendation-snooze") {
      sendJson(response, 200, await handleRecommendationSnooze(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/answer") {
      sendJson(response, 200, await handleKnowledgeAnswer(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/materials/ingest-url") {
      const body = await readJsonBody(request);
      if (!body.userId) {
        throw new Error("userId is required.");
      }
      const converted = await convertRemoteMaterialUrl(body.url);
      const material = await saveCustomMaterial({
        userId: body.userId,
        ...converted,
      });
      sendJson(response, 200, { material });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/materials/upload") {
      const body = await readJsonBody(request);
      if (!body.userId) {
        throw new Error("userId is required.");
      }
      const converted = await convertUploadedMaterial({
        filename: body.filename,
        mimeType: body.mimeType,
        contentBase64: body.contentBase64,
      });
      const material = await saveCustomMaterial({
        userId: body.userId,
        ...converted,
      });
      sendJson(response, 200, { material });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/materials") {
      const userId = url.searchParams.get("userId") || "";
      if (!userId) {
        throw new Error("userId is required.");
      }
      sendJson(response, 200, { materials: await listCustomMaterials(userId) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/materials/original") {
      const userId = url.searchParams.get("userId") || "";
      const materialPath = url.searchParams.get("path") || "";
      const original = await readCustomMaterialOriginal(userId, materialPath);
      if (original.redirectUrl) {
        response.writeHead(302, {
          "access-control-allow-origin": "*",
          location: original.redirectUrl,
        });
        response.end();
      } else {
        sendBuffer(response, 200, original.body, {
          "cache-control": "private, max-age=60",
          "content-disposition": buildSafeContentDisposition(original.filename || "original"),
          "content-type": original.mimeType,
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/materials/render") {
      const userId = url.searchParams.get("userId") || "";
      const materialPath = url.searchParams.get("path") || "";
      const rendered = await readCustomMaterialRender(userId, materialPath);
      sendBuffer(response, 200, rendered.body, {
        "cache-control": "private, max-age=60",
        "content-disposition": buildSafeContentDisposition(rendered.filename || "rendered.html"),
        "content-type": rendered.mimeType,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/doc") {
      const docPath = url.searchParams.get("path") || url.searchParams.get("doc") || "";
      const document = await readSourceDocument(docPath, {
        userId: url.searchParams.get("userId") || "",
        serviceBaseUrl: buildServiceBaseUrl(request),
      });
      sendJson(response, 200, document);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/docs") {
      sendJson(response, 200, { documents: await listSourceDocuments({ userId: url.searchParams.get("userId") || "" }) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/asset") {
      const assetPath = url.searchParams.get("path");
      const remoteUrl = url.searchParams.get("url");

      if (assetPath) {
        try {
          const asset = await readSourceAsset(assetPath);
          sendBuffer(response, 200, asset.body, {
            "cache-control": "public, max-age=3600",
            "content-type": asset.mimeType,
          });
        } catch (error) {
          if (error.code !== "ENOENT") {
            throw error;
          }
          sendBuffer(response, 200, buildMissingAssetPlaceholder(assetPath), {
            "cache-control": "public, max-age=300",
            "content-type": "image/svg+xml; charset=utf-8",
          });
        }
        return;
      }

      if (remoteUrl) {
        const upstream = await fetch(remoteUrl);
        if (!upstream.ok) {
          throw new Error("Remote asset request failed.");
        }
        sendBuffer(response, 200, Buffer.from(await upstream.arrayBuffer()), {
          "cache-control": "public, max-age=3600",
          "content-type": upstream.headers.get("content-type") || "application/octet-stream",
        });
        return;
      }

      throw new Error("knowledge asset path is required.");
    }

    if (request.method === "GET" && url.pathname === "/api/knowledge/redirect") {
      const remoteUrl = url.searchParams.get("url") || "";
      if (!/^https?:\/\//i.test(remoteUrl)) {
        throw new Error("knowledge redirect url is invalid.");
      }
      response.writeHead(302, {
        "access-control-allow-origin": "*",
        location: remoteUrl,
      });
      response.end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/start-target") {
      sendJson(response, 200, await handleStartTarget(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/answer") {
      sendJson(response, 200, await handleAnswer(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/answer-stream") {
      await handleAnswerStream(await readJsonBody(request), response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-domain") {
      sendJson(response, 200, await handleFocusDomain(await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/interview/focus-concept") {
      sendJson(response, 200, await handleFocusConcept(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/interview/")) {
      const { data: result, traceId } = await proxyJson("GET", url.pathname);
      sendJson(response, 200, stripSessionPayload({ ...result, traceId }));
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    sendErrorJson(response, 400, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

if (process.env.NODE_ENV !== "test") {
  server.listen(port, () => {
    console.log(`Learning Loop BFF listening on http://localhost:${port}`);
  });
}

export { server, isCompletedDocumentSession, isResumableDocumentSession };
