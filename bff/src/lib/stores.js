import { createCampaignGoalStore } from "../../../src/goals/campaign-goal-store.js";
import { createDrillPassthrough } from "../../../src/ledger/drill-passthrough.js";
import { createReviewItemStore } from "../../../src/ledger/review-item-store.js";
import { createLoopAssistRescuePlaylistStore } from "../../../src/loopassist/rescue-playlist-store.js";
import { createMemoryProfileStore } from "../../../src/tutor/memory-profile-store.js";
import { createSessionSummariesStore } from "../../../src/user/session-summary-store.js";
import { createUserProfileStore } from "../../../src/user/user-profile-store.js";
import { createUserRulesStore } from "../../../src/user/user-rules-store.js";

export const memoryProfileStore = createMemoryProfileStore();

export const userProfileStore = createUserProfileStore();

export const userRulesStore = createUserRulesStore();

export const sessionSummariesStore = createSessionSummariesStore();

export const rescuePlaylistStore = createLoopAssistRescuePlaylistStore();
// 失败账本（PRODUCT.md §4）。写端 = 穿透适配器（阶段 3），读端 = Today Queue「今日复习」（阶段 4）。

export const reviewItemStore = createReviewItemStore();

// 面试战役 Goal（PRODUCT.md 持久实体 ①）：deadline + per-Goal 覆盖度清单，随战役生灭。
export const campaignGoalStore = createCampaignGoalStore();

export const drillPassthrough = createDrillPassthrough({ store: reviewItemStore });

// loopassist 复盘里每道题就是一轮 drill。逐题喂一次性锚点判分、答崩写账本。
// detached：每条是一次 LLM 判分，不阻塞复盘响应；passthrough 自带兜底吞错。
