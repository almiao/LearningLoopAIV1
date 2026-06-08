// 复习调度 — PRODUCT.md §4 点名的「真设计题」。
//
// 刻意不套 SM-2 / FSRS：它们假设原子卡片 + 二元回忆 + 连续 ease/stability 因子。
// 本产品的单元是「失败点」，状态只有 shaky/solid（§4），判分是命中/漏锚点而非二元回忆。
// 所以调度只吃两个粗信号：**状态转移** + **连续 solid 次数 (streak)**：
//   - shaky：永远短间隔（隔天再练）。
//   - solid：streak 越大，间隔按阶梯扩张（expanding rehearsal），到顶封顶。
//   - 再答崩（回 shaky）：streak 清零、间隔回到 1 天。
// 阶梯是可调 config，正是「当专门设计任务对待」——以后用真实数据校准。

const DAY_MS = 24 * 60 * 60 * 1000;

export const SHAKY_INTERVAL_DAYS = 1;
// solid 第 1/2/3/4/5+ 次连续的间隔（天）。约 ×2.2 扩张，贴遗忘曲线、到顶封顶。
export const SOLID_INTERVAL_LADDER_DAYS = [3, 7, 16, 35, 75];

function toMs(value, fallback) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value || "");
  return Number.isFinite(ms) ? ms : fallback;
}

// 输入当前判定的 state + 之前的 streak（+ 可选 deadline），算出下一次 next_due 与新 streak。
// 纯函数：不读盘、不依赖时钟（now 可注入），方便测试与审计。
export function scheduleNextReview({ state = "shaky", priorStreak = 0, now = new Date(), deadline = null } = {}) {
  const baseMs = toMs(now, Date.now());

  let streak;
  let intervalDays;
  if (state === "solid") {
    streak = Math.max(0, Math.floor(Number(priorStreak) || 0)) + 1;
    const index = Math.min(streak - 1, SOLID_INTERVAL_LADDER_DAYS.length - 1);
    intervalDays = SOLID_INTERVAL_LADDER_DAYS[index];
  } else {
    streak = 0;
    intervalDays = SHAKY_INTERVAL_DAYS;
  }

  let nextMs = baseMs + intervalDays * DAY_MS;

  // deadline-aware（面试战役 §③）：复习不能排到面试之后 → 被 deadline 封顶。
  const deadlineMs = deadline ? toMs(deadline, NaN) : NaN;
  if (Number.isFinite(deadlineMs)) {
    nextMs = Math.min(nextMs, deadlineMs);
  }

  return {
    streak,
    intervalDays,
    nextDueAt: new Date(nextMs).toISOString(),
  };
}
