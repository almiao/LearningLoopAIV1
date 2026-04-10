"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../lib/api";

const userIdStorageKey = "learning-loop-user-id";

export default function ProfilePage() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const userId = window.localStorage.getItem(userIdStorageKey) || "";
    if (!userId) {
      setError("当前没有已登录用户。");
      return;
    }
    apiFetch(`/api/profile/${userId}`)
      .then((data) => setProfile(data))
      .catch((nextError) => setError(nextError.message));
  }, []);

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Profile</p>
        <h1>学习档案</h1>
        <p className="lede">这里直接展示所有目标，以及目标下能力域/能力项的进展测评情况。</p>
      </section>

      <section className="panel">
        <div className="actions">
          <Link className="secondary" href="/">返回主工作台</Link>
        </div>
      </section>

      {error ? <section className="panel"><div className="chip">{error}</div></section> : null}

      {profile ? (
        <>
          <section className="panel">
            <h2>{profile.user.handle}</h2>
            <div className="summary-grid">
              {[
                ["目标数", profile.summary.totalTargets],
                ["累计会话", profile.summary.sessionsStarted],
                ["已评估项", profile.summary.assessedAbilityItems],
                ["Solid", profile.summary.solidItems],
                ["Partial", profile.summary.partialItems],
                ["Weak", profile.summary.weakItems]
              ].map(([label, value]) => (
                <article className="card summary-card" key={label}>
                  <small className="muted">{label}</small>
                  <strong>{value}</strong>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>目标档案</h2>
            <div className="list">
              {(profile.targets || []).map((target) => (
                <article className="card" key={target.targetBaselineId}>
                  <h3>{target.title}</h3>
                  <p className="muted">{target.targetRole}</p>
                  <p><span className="chip">{target.completionPercentage}%</span> {target.completionLabel}</p>
                  <p className="muted">已评估 {target.assessedItemCount} / {target.totalItemCount} 项 · 已启动 {target.sessionsStarted} 次</p>
                  <div className="list">
                    {(target.domains || []).map((domain) => (
                      <section className="card" key={domain.id}>
                        <h4>{domain.title}</h4>
                        <p className="muted">进度 {domain.progressPercentage}% · 已评估 {domain.assessedItemCount} / {domain.totalItemCount}</p>
                        <ul>
                          {(domain.items || []).map((item) => (
                            <li key={item.abilityItemId}>
                              <strong>{item.title}</strong> <span className="chip">{item.state}</span> <small>{item.progressPercentage}% · {item.evidenceCount} 条证据</small>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}
