"use client";

import { useState } from "react";
import { MiniIcon } from "./shared";

function normalizeScore(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function getScoreBand(score = 0) {
  const value = normalizeScore(score);
  if (value >= 90) {
    return { key: "excellent", background: "#1D9E75", color: "#FFFFFF" };
  }
  if (value >= 75) {
    return { key: "solid", background: "#97C459", color: "#0F6E56" };
  }
  if (value >= 60) {
    return { key: "partial", background: "#EF9F27", color: "#FFFFFF" };
  }
  if (value >= 40) {
    return { key: "weak", background: "#E27272", color: "#FFFFFF" };
  }
  return { key: "critical", background: "#A32D2D", color: "#FFFFFF" };
}

function getAverageScoreColor(score = 0) {
  const value = normalizeScore(score);
  if (value >= 90) {
    return "#0F6E56";
  }
  if (value < 60) {
    return "#A32D2D";
  }
  return "#63635E";
}

function uniqueStrings(items = []) {
  return Array.from(new Set(items.map((item) => String(item || "").trim()).filter(Boolean)));
}

// 收尾只给真实结果与下一步（PRODUCT §3④）：没有判分就显示没有，不用 demo 数据补位。

export function buildTrainingCompletionSummary({
  session = null,
  points = [],
  exchanges = [],
  documentTitle = "",
} = {}) {
  const pointRows = (points || []).map((point, pointIndex) => {
    const scores = (point.checkpoints || []).map((checkpoint) => {
      const state = session?.conceptStates?.[checkpoint.id] || {};
      const judgeScore = state?.judge?.score;
      const exchange = exchanges.find((item) => item.checkpointStatement === checkpoint.statement || item.checkpointStatement === checkpoint.checkpointStatement);
      return normalizeScore(judgeScore ?? exchange?.scoreSummary?.score, 0);
    }).filter((score) => score > 0);
    return {
      id: point.id || `point-${pointIndex}`,
      title: point.title || `训练点 ${pointIndex + 1}`,
      conceptIds: (point.checkpoints || []).map((checkpoint) => checkpoint.id).filter(Boolean),
      scores,
      average: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    };
  });

  const rows = pointRows.filter((row) => row.scores.length);
  const allScores = rows.flatMap((row) => row.scores);
  const completedCount = allScores.length;
  const totalCount = Math.max(completedCount, points.flatMap((point) => point.checkpoints || []).length);
  const averageScore = allScores.length
    ? Math.round(allScores.reduce((sum, score) => sum + score, 0) / allScores.length)
    : 0;
  const timestamps = (session?.turns || []).map((turn) => Number(turn.timestamp || 0)).filter((value) => value > 0);
  const durationMinutes = timestamps.length >= 2
    ? Math.max(1, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60000))
    : 0;
  const weakRows = rows
    .filter((row) => row.average < 70 || row.scores.some((score) => score < 60))
    .map((row) => {
      const relatedExchanges = exchanges.filter((exchange) => row.conceptIds.includes(exchange.checkpointId) || row.title === exchange.pointTitle);
      const reasons = uniqueStrings(relatedExchanges.map((exchange) => exchange.scoreSummary?.reason || exchange.improvement));
      return {
        id: row.id,
        title: row.title,
        wrongCount: row.scores.filter((score) => score < 60).length || 1,
        diagnosis: reasons.slice(0, 2).join(" · ") || "关键点还没讲到位，需要再练一轮压实。",
        conceptId: row.conceptIds[0] || row.id,
      };
    });
  const takeaways = uniqueStrings(exchanges.map((exchange) => exchange.takeaway)).slice(0, 8);

  return {
    documentTitle: documentTitle || "本次训练",
    drilledPointCount: rows.length,
    passedPointCount: Math.max(0, rows.length - weakRows.length),
    completedCount,
    totalCount,
    averageScore,
    durationMinutes,
    pointRows: rows,
    weakPoints: weakRows,
    takeaways,
  };
}

function TrainingSummaryHero({ summary }) {
  return (
    <section className="ll-summary-hero">
      <div className="ll-summary-chip">
        <MiniIcon name="confetti" />
        本轮训练完成
      </div>
      <p>{summary.drilledPointCount ? `这轮一共练了 ${summary.drilledPointCount} 个点` : "这轮还没有可判分的回答"}</p>
      <div className="ll-summary-mastery-row">
        <strong className="ll-summary-outcome is-passed">{`过线 ${summary.passedPointCount}`}</strong>
        <span className="ll-summary-outcome-divider" aria-hidden="true">·</span>
        <strong className="ll-summary-outcome is-review">{`进复习账本 ${summary.weakPoints.length}`}</strong>
      </div>
      <small>
        {summary.weakPoints.length
          ? "进账本的点到期后会出现在首页「今日复习」。"
          : "这轮没有新的薄弱点进账本。"}
      </small>
    </section>
  );
}

function TrainingSummaryMetricGrid({ summary }) {
  const metrics = [
    { label: "完成", value: `${summary.completedCount} / ${summary.totalCount}`, unit: "题" },
    { label: "平均分", value: summary.averageScore, unit: "分", color: getAverageScoreColor(summary.averageScore) },
    { label: "用时", value: summary.durationMinutes, unit: "分钟" },
  ];
  return (
    <section className="ll-summary-metrics">
      {metrics.map((metric) => (
        <article key={metric.label}>
          <span>{metric.label}</span>
          <strong style={{ color: metric.color || "#191917" }}>{metric.value}</strong>
          <em>{metric.unit}</em>
        </article>
      ))}
    </section>
  );
}

function TrainingPointDistribution({ rows }) {
  return (
    <section className="ll-summary-section ll-summary-distribution">
      <h2>{`${rows.length} 个训练点分布`}</h2>
      <div className="ll-summary-point-list">
        {rows.map((row) => (
          <div key={row.id} className="ll-summary-point-row">
            <strong>{row.title}</strong>
            <div className="ll-summary-score-blocks">
              {row.scores.map((score, index) => {
                const band = getScoreBand(score);
                return (
                  <span key={`${row.id}:${index}`} style={{ background: band.background, color: band.color }}>
                    {score}
                  </span>
                );
              })}
            </div>
            <em>{`${row.average} 分`}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function WeakPointActions({ weakPoints, onReviewWeakPoint }) {
  return (
    <section className="ll-summary-weak">
      <h2>
        <MiniIcon name="target" />
        {`${weakPoints.length} 处明显薄弱，系统已加入复习队列`}
      </h2>
      <div className="ll-summary-weak-list">
        {weakPoints.map((point) => (
          <article key={point.id} className="ll-summary-weak-card">
            <div>
              <strong>{point.title}</strong>
              <span>{`答错 ${point.wrongCount} 题`}</span>
              <p>{point.diagnosis}</p>
            </div>
            <button type="button" onClick={() => onReviewWeakPoint(point.conceptId)}>
              立即重练
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function TakeawayCards({ takeaways }) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? takeaways : takeaways.slice(0, 3);
  return (
    <section className="ll-summary-section ll-summary-takeaways">
      <div className="ll-summary-section-head">
        <h2>本轮带走的</h2>
        <span>{`${takeaways.length} 张知识卡片 · 会出现在未来复习中`}</span>
      </div>
      <div className="ll-summary-takeaway-grid">
        {visibleItems.map((item) => (
          <article key={item}>
            <MiniIcon name="bookmark" />
            <p>{item}</p>
          </article>
        ))}
      </div>
      {takeaways.length > 3 ? (
        <button type="button" className="ll-summary-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起知识卡片 ▴" : `展开全部 ${takeaways.length} 张 ▾`}
        </button>
      ) : null}
    </section>
  );
}

function TomorrowReviewBanner({ summary, onReviewPlan, onDismiss }) {
  return (
    <section className="ll-summary-tomorrow">
      <div className="ll-summary-calendar">
        <MiniIcon name="calendar" />
      </div>
      <div>
        <h2>明天还有事</h2>
        <p>{`${summary.weakPoints.length} 处薄弱点已写进复习账本，到期会出现在首页「今日复习」，趁记忆新鲜补上。`}</p>
        <div>
          <button type="button" onClick={onReviewPlan}>查看复习计划</button>
          <button type="button" onClick={onDismiss}>关闭提醒</button>
        </div>
      </div>
    </section>
  );
}

function TrainingSharePanel({ summary, onClose }) {
  return (
    <div className="ll-summary-share-backdrop" role="presentation" onClick={onClose}>
      <section className="ll-summary-share-panel" role="dialog" aria-modal="true" aria-label="分享成绩" onClick={(event) => event.stopPropagation()}>
        <div className="ll-summary-section-head">
          <h2>分享成绩</h2>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
        <div className="ll-summary-share-card">
          <span>{summary.documentTitle}</span>
          <strong>{`本轮 ${summary.completedCount} 题 · 过线 ${summary.passedPointCount}/${summary.drilledPointCount} 个点`}</strong>
          <p>{summary.takeaways.slice(0, 3).join(" / ")}</p>
        </div>
        <p>分享内容只展示你的学习成果，不包含产品宣传。</p>
      </section>
    </div>
  );
}

export function TrainingCompletionSummaryPage({
  summary,
  onBackToReading,
  onReviewWeakPoint,
  onReviewPlan,
  onHome,
  onNextDocument,
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [tomorrowVisible, setTomorrowVisible] = useState(true);
  return (
    <main className="learn-shell ll-training-summary-page" data-testid="training-completion-summary">
      <header className="ll-summary-topbar">
        <button type="button" aria-label="返回" onClick={onBackToReading}>‹</button>
        <h1>{summary.documentTitle}</h1>
        <span>训练完成</span>
      </header>
      <div className="ll-summary-body">
        <TrainingSummaryHero summary={summary} />
        <TrainingSummaryMetricGrid summary={summary} />
        {summary.pointRows.length ? <TrainingPointDistribution rows={summary.pointRows} /> : null}
        {summary.weakPoints.length ? <WeakPointActions weakPoints={summary.weakPoints} onReviewWeakPoint={onReviewWeakPoint} /> : null}
        {summary.takeaways.length ? <TakeawayCards takeaways={summary.takeaways} /> : null}
        {tomorrowVisible && summary.weakPoints.length ? (
          <TomorrowReviewBanner
            summary={summary}
            onReviewPlan={onReviewPlan}
            onDismiss={() => setTomorrowVisible(false)}
          />
        ) : null}
        <footer className="ll-summary-actions">
          <div>
            <button type="button" onClick={onBackToReading}>查看完整记录</button>
            <button type="button" onClick={() => setShareOpen(true)}>
              <MiniIcon name="share" />
              分享成绩
            </button>
          </div>
          <div>
            <button type="button" className="ll-summary-secondary" onClick={onHome}>回首页</button>
            <button type="button" className="ll-summary-primary" onClick={onNextDocument}>继续学下一份 →</button>
          </div>
        </footer>
      </div>
      {shareOpen ? <TrainingSharePanel summary={summary} onClose={() => setShareOpen(false)} /> : null}
    </main>
  );
}
