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

  if (!profile) {
    return (
      <main className="profile-shell">
        <section className="profile-header">
          <div className="brand-chip">L</div>
          <div className="profile-header-copy">
            <h1>个人档案</h1>
            <p>按不同学习目标查看进展、记忆内容与下一步建议。</p>
          </div>
        </section>
        <section className="gate-card">
          <h2>{error || "正在载入档案..."}</h2>
          <p>先从首页连接学习档案，再回来查看目标进展和长期记忆。</p>
          <Link className="primary-pill" href="/">返回首页</Link>
        </section>
      </main>
    );
  }

  const primaryTarget = profile.targets?.[0];

  return (
    <main className="profile-shell">
      <section className="profile-header">
        <div className="brand-chip">L</div>
        <div className="profile-header-copy">
          <h1>个人档案</h1>
          <p>按不同学习目标查看进展、记忆内容与下一步建议。</p>
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
                当前聚焦 {primaryTarget?.title || "学习目标"}，系统会持续记录练习证据、对话反馈和下一步建议。
              </p>
            </div>
            <div className="summary-stat-strip">
              <div>
                <strong>{primaryTarget?.completionPercentage || 0}%</strong>
                <span>总进度</span>
              </div>
              <div>
                <strong>{profile.summary.sessionsStarted}</strong>
                <span>累计练习</span>
              </div>
            </div>
          </article>

          <section className="section-heading">
            <h2>学习目标进展</h2>
            <p>不同目标分别沉淀进度、薄弱点和下一步任务。</p>
          </section>

          <div className="goal-card-list">
            {(profile.targets || []).map((target) => (
              <article className="goal-card" key={target.targetBaselineId}>
                <div className="goal-card-head">
                  <div>
                    <h3>{target.title}</h3>
                    <p>{target.targetRole}</p>
                  </div>
                  <strong>{target.completionPercentage}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${target.completionPercentage}%` }} />
                </div>
                <p className="goal-caption">
                  已评估 {target.assessedItemCount} / {target.totalItemCount} 项，已启动 {target.sessionsStarted} 次
                </p>
                <div className="goal-pill-row">
                  {(target.domains || []).slice(0, 3).map((domain) => (
                    <span className={`goal-pill ${progressTone(domain.progressPercentage)}`} key={domain.id}>
                      {domain.title} {domain.progressPercentage}%
                    </span>
                  ))}
                </div>
              </article>
            ))}
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
                      <span>{item.evidenceCount} 条证据 · {item.targetTitle}</span>
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
