"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { getStoredUserId } from "../lib/user-session";

function formatState(state) {
  if (state === "solid") {
    return "稳定";
  }
  if (state === "partial") {
    return "持续推进";
  }
  if (state === "weak") {
    return "待补强";
  }
  return "待建立";
}

function progressTone(progress) {
  if (progress >= 70) {
    return "good";
  }
  if (progress >= 35) {
    return "mid";
  }
  return "low";
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

  const flattenedItems = useMemo(() => {
    if (!profile) {
      return [];
    }
    return (profile.targets || []).flatMap((target) =>
      (target.domains || []).flatMap((domain) =>
        (domain.items || []).map((item) => ({
          ...item,
          targetTitle: target.title,
          domainTitle: domain.title,
        }))
      )
    );
  }, [profile]);

  const assessedItems = flattenedItems.filter((item) => item.evidenceCount > 0);
  const weakItems = flattenedItems
    .filter((item) => item.state === "weak" || item.state === "partial")
    .sort((left, right) => left.progressPercentage - right.progressPercentage)
    .slice(0, 4);
  const recentItems = assessedItems
    .slice()
    .sort((left, right) => (right.evidenceCount || 0) - (left.evidenceCount || 0))
    .slice(0, 4);
  const documentItems = useMemo(() => {
    return Object.values(profile?.documentProgress?.docs || {})
      .sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")));
  }, [profile]);

  if (!profile) {
    return (
      <main className="profile-shell">
        <section className="profile-header">
          <div className="brand-chip">L</div>
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
      <section className="profile-header">
        <div className="brand-chip">L</div>
        <div className="profile-header-copy">
          <h1>个人档案</h1>
          <p>查看文档阅读、训练进展、记忆内容与下一步建议。</p>
        </div>
        <div className="memory-status-pill">
          <span className="status-dot" />
          <span>记忆模式已开启</span>
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
                  <span className={`goal-pill ${progressTone(document.masteryPercentage || 0)}`}>
                    掌握 {document.masteryPercentage || 0}%
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
              {weakItems.length ? (
                <ul>
                  {weakItems.map((item) => (
                    <li key={item.abilityItemId}>
                      <strong>{item.title}</strong>
                      <span>{item.domainTitle} · {formatState(item.state)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>已经有了一批稳定证据，下一轮可以继续扩展更广的能力域。</p>
              )}
            </article>

            <article className="recent-activity-card">
              <h3>最近学习</h3>
              {recentItems.length ? (
                <ul>
                  {recentItems.map((item) => (
                    <li key={item.abilityItemId}>
                      <strong>{item.title}</strong>
                      <span>{item.evidenceCount} 条证据 · 训练记忆</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>还没有近期证据，开始一轮学习后这里会出现最近推进过的知识项目。</p>
              )}
            </article>
          </div>
        </section>

        <aside className="memory-column">
          <section className="memory-column-head">
            <h2>记忆内容</h2>
            <p>汇总用户在学习目标、对话反馈和长期偏好中的关键记忆。</p>
          </section>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>记忆摘要</strong>
            </div>
            <p>
              用户当前已建立 {profile.summary.assessedAbilityItems} 项可用证据，其中稳定 {profile.summary.solidItems} 项、
              进行中 {profile.summary.partialItems} 项、待补强 {profile.summary.weakItems} 项。
            </p>
          </article>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>本次沉淀的关键记忆</strong>
            </div>
            <div className="memory-list">
              {recentItems.length ? recentItems.map((item) => (
                <div className="memory-list-item" key={item.abilityItemId}>
                  <span className="memory-bullet success" />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.domainTitle} · {item.evidenceCount} 条证据</p>
                  </div>
                </div>
              )) : <p>进入学习后，新的能力证据会沉淀到这里。</p>}
            </div>
          </article>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>长期偏好</strong>
            </div>
            <p>
              当前更适合沿着同一学习目标持续推进，先收敛关键概念，再根据证据把薄弱点转成明确下一步。
            </p>
          </article>

          <article className="memory-card">
            <div className="memory-card-head">
              <strong>待确认记忆</strong>
            </div>
            <div className="memory-list">
              {weakItems.length ? weakItems.map((item) => (
                <div className="memory-list-item" key={item.abilityItemId}>
                  <span className="memory-bullet warning" />
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.domainTitle} · {formatState(item.state)}</p>
                  </div>
                </div>
              )) : <p>当前没有待确认的薄弱项，可以继续扩大覆盖范围。</p>}
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
