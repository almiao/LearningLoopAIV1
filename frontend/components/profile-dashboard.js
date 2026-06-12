"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";

function progressTone(progress) {
  if (progress >= 70) {
    return "good";
  }
  if (progress >= 35) {
    return "mid";
  }
  return "low";
}

function formatReviewWindow(nextReviewAt = "") {
  if (!nextReviewAt) {
    return "";
  }
  const date = new Date(nextReviewAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) {
    return "复习时间已到";
  }
  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 1) {
    return "建议明天前复习";
  }
  return `${diffDays} 天内适合复习`;
}

export function ProfileDashboard() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const userId = getStoredUserId();
    if (!userId) {
      setError("当前没有已连接的学习档案。");
      return;
    }
    apiFetch(`/api/profile/${userId}`)
      .then((data) => setProfile(data))
      .catch((nextError) => setError(nextError.message));
  }, []);

  const userRules = profile?.userRules || [];
  const sessionSummaries = profile?.sessionSummaries || [];
  const documentItems = useMemo(() => {
    return Object.values(profile?.documentProgress?.docs || {})
      .sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")));
  }, [profile]);
  const recentSessions = useMemo(() => (
    sessionSummaries
      .slice()
      .sort((left, right) => String(right.endedAt || "").localeCompare(String(left.endedAt || "")))
      .slice(0, 4)
  ), [sessionSummaries]);
  const reviewReadyDocuments = useMemo(() => (
    documentItems
      .filter((document) => document.nextReviewAt || document.trainingStarted || document.evidenceCount > 0)
      .sort((left, right) => {
        const leftDue = Date.parse(left.nextReviewAt || "");
        const rightDue = Date.parse(right.nextReviewAt || "");
        const leftHasDue = Number.isFinite(leftDue);
        const rightHasDue = Number.isFinite(rightDue);
        if (leftHasDue !== rightHasDue) {
          return leftHasDue ? -1 : 1;
        }
        if (leftHasDue && rightHasDue && leftDue !== rightDue) {
          return leftDue - rightDue;
        }
        return String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || ""));
      })
      .slice(0, 4)
  ), [documentItems]);
  const recentPracticeDocuments = useMemo(() => (
    documentItems
      .filter((document) => (document.evidenceCount || 0) > 0 || (document.trainingAnswerCount || 0) > 0)
      .slice(0, 4)
  ), [documentItems]);
  const totalEvidenceCount = useMemo(() => (
    documentItems.reduce((sum, document) => sum + Number(document.evidenceCount || 0), 0)
  ), [documentItems]);

  if (!profile) {
    return (
      <main className="profile-shell">
        <header className="ll-topbar">
          <Link href="/" className="ll-brand">
            <span className="ll-brand-mark" aria-hidden="true" />
            <span>LearningLoop</span>
          </Link>
          <div className="ll-topbar-actions">
            <Link href="/" className="ll-secondary-button">← 返回首页</Link>
          </div>
        </header>
        <section className="profile-header">
          <div className="profile-header-copy">
            <h1>个人档案</h1>
            <p>查看文档阅读、训练进展、记忆内容与下一步建议。</p>
          </div>
        </section>
        <section className="gate-card">
          <h2>{error || "正在载入档案..."}</h2>
          <p>先从首页连接学习档案，再回来查看文档进展和长期记忆。</p>
          <Link className="primary-pill" href="/">返回首页</Link>
        </section>
      </main>
    );
  }

  const primaryDocument = documentItems[0] || null;

  return (
    <main className="profile-shell">
      <header className="ll-topbar">
        <Link href="/" className="ll-brand">
          <span className="ll-brand-mark" aria-hidden="true" />
          <span>LearningLoop</span>
        </Link>
        <div className="ll-topbar-actions">
          <Link href="/" className="ll-secondary-button">← 返回首页</Link>
        </div>
      </header>
      <section className="profile-header">
        <div className="profile-header-copy">
          <h1>个人档案</h1>
          <p>查看文档阅读、训练进展、记忆内容与下一步建议。</p>
        </div>
        <div className="memory-status-pill">
          <span className="status-dot" />
          <span>学习记录已同步</span>
        </div>
      </section>

      <section className="profile-body">
        <section className="profile-main-column">
          <article className="learner-summary-card">
            <div className="avatar-tile">{profile.user.handle.slice(0, 3)}</div>
            <div className="learner-summary-copy">
              <h2>{profile.user.handle} 的学习档案</h2>
              <p>
                当前聚焦 {primaryDocument?.docTitle || "文档学习"}，系统会持续记录阅读、训练证据、对话反馈和下一步建议。
              </p>
            </div>
            <div className="summary-stat-strip">
              <div>
                <strong>{profile.documentProgress?.stats?.completedReadingCount || 0}</strong>
                <span>已读文档</span>
              </div>
              <div>
                <strong>{profile.documentProgress?.stats?.startedTrainingCount || 0}</strong>
                <span>已开训练</span>
              </div>
              <div>
                <strong>{recentSessions.length}</strong>
                <span>最近轮次</span>
              </div>
            </div>
          </article>

          <section className="section-heading">
            <h2>文档学习进展</h2>
            <p>每篇文档独立记录阅读、训练和掌握状态。</p>
          </section>

          <div className="goal-card-list">
            {documentItems.length ? documentItems.slice(0, 8).map((document) => (
              <article className="goal-card" key={document.docPath}>
                <div className="goal-card-head">
                  <div>
                    <h3>{document.docTitle || document.docPath}</h3>
                    <p>{document.docPath}</p>
                  </div>
                  <strong>{document.progressPercentage || 0}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${document.progressPercentage || 0}%` }} />
                </div>
                <p className="goal-caption">
                  {document.readingLabel || "未读"} · {document.learningStatusLabel || "未训练"} ·
                  {" "}
                  证据 {document.evidenceCount || 0} 条，答题 {document.trainingAnswerCount || 0} 次
                </p>
                <div className="goal-pill-row">
                  <span className={`goal-pill ${progressTone(document.progressPercentage || 0)}`}>
                    阅读 {document.readingLabel || "未读"}
                  </span>
                </div>
              </article>
            )) : (
              <article className="goal-card">
                <div className="goal-card-head">
                  <div>
                    <h3>还没有文档进展</h3>
                    <p>开始阅读或训练后，这里会显示最近学习过的文档。</p>
                  </div>
                  <strong>0%</strong>
                </div>
              </article>
            )}
          </div>

          <div className="profile-bottom-grid">
            <article className="next-step-card">
              <h3>下一步建议</h3>
              {reviewReadyDocuments.length ? (
                <ul>
                  {reviewReadyDocuments.map((document) => (
                    <li key={document.docPath}>
                      <strong>{document.docTitle || document.docPath}</strong>
                      <span>
                        {[
                          document.learningStatusLabel || "未训练",
                          formatReviewWindow(document.nextReviewAt || ""),
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>当前没有临近的复习项，下一轮可以继续扩展新的文档或补一场模拟。</p>
              )}
            </article>

            <article className="recent-activity-card">
              <h3>最近学习</h3>
              {recentSessions.length ? (
                <ul>
                  {recentSessions.map((summary) => (
                    <li key={summary.sessionId}>
                      <strong>{summary.docPath}</strong>
                      <span>{summary.oneParagraphSummary || "这一轮已经收口，可以从这里接着推进。"}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>还没有最近轮次记录，开始一轮学习后这里会出现最新的收口摘要。</p>
              )}
            </article>
          </div>
        </section>

        <aside className="memory-column">
          <section className="memory-column-head">
            <h2>学习侧写</h2>
            <p>先看真实学习痕迹，再看偏好与最近收口，不再把旧掌握度图当主舞台。</p>
          </section>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>学习摘要</strong>
            </div>
            <p>
              最近共沉淀了 {totalEvidenceCount} 条答题证据，已读文档 {profile.documentProgress?.stats?.completedReadingCount || 0} 篇，
              已开训练 {profile.documentProgress?.stats?.startedTrainingCount || 0} 篇，最近收口 {recentSessions.length} 轮。
            </p>
          </article>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>最近练习痕迹</strong>
            </div>
            <div className="memory-list">
              {recentPracticeDocuments.length ? recentPracticeDocuments.map((document) => (
                <div className="memory-list-item" key={document.docPath}>
                  <span className="memory-bullet success" />
                  <div>
                    <strong>{document.docTitle || document.docPath}</strong>
                    <p>{document.learningStatusLabel || "未训练"} · {document.evidenceCount || 0} 条证据</p>
                    {document.nextReviewAt ? (
                      <p>
                        {formatReviewWindow(document.nextReviewAt)}
                      </p>
                    ) : null}
                  </div>
                </div>
              )) : <p>进入学习后，最近的训练痕迹会沉淀到这里。</p>}
            </div>
          </article>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>学习偏好与约束</strong>
            </div>
            <div className="memory-list">
              {userRules.length ? userRules.slice(0, 4).map((rule) => (
                <div className="memory-list-item" key={rule.id}>
                  <span className="memory-bullet success" />
                  <div>
                    <strong>{rule.kind === "constraint" ? "约束" : "偏好"}</strong>
                    <p>{rule.text}</p>
                  </div>
                </div>
              )) : <p>还没有稳定的学习偏好记录。随着你调整互动风格，这里会逐渐形成可复用规则。</p>}
            </div>
          </article>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>最近一轮总结</strong>
            </div>
            <div className="memory-list">
              {recentSessions.length ? recentSessions.slice(0, 3).map((summary) => (
                <div className="memory-list-item" key={summary.sessionId}>
                  <span className="memory-bullet success" />
                  <div>
                    <strong>{summary.docPath}</strong>
                    <p>{summary.oneParagraphSummary || "本轮已收口，等你下次继续。"}</p>
                    {summary.recommendedNextAction ? <p>{`下次默认动作：${summary.recommendedNextAction}`}</p> : null}
                  </div>
                </div>
              )) : reviewReadyDocuments.length ? reviewReadyDocuments.map((document) => (
                <div className="memory-list-item" key={document.docPath}>
                  <span className="memory-bullet warning" />
                  <div>
                    <strong>{document.docTitle || document.docPath}</strong>
                    <p>{document.learningStatusLabel || "未训练"}</p>
                  </div>
                </div>
              )) : <p>当前没有待复习知识点，可以继续扩大覆盖范围。</p>}
            </div>
            <div className="memory-actions">
              <Link className="secondary-pill" href="/learn">继续学习</Link>
              <Link className="primary-pill" href="/">返回首页</Link>
            </div>
          </article>
        </aside>
      </section>
    </main>
  );
}
