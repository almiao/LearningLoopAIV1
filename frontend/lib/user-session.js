const userIdStorageKey = "learning-loop-user-id";
const baselineStorageKey = "learning-loop-target-baseline-id";

function canUseStorage() {
  return typeof window !== "undefined";
}

export function getStoredUserId() {
  if (!canUseStorage()) {
    return "";
  }
  return window.localStorage.getItem(userIdStorageKey) || "";
}

export function setStoredUserId(userId) {
  if (!canUseStorage()) {
    return;
  }
  if (userId) {
    window.localStorage.setItem(userIdStorageKey, userId);
    return;
  }
  window.localStorage.removeItem(userIdStorageKey);
}

export function getStoredTargetBaselineId() {
  if (!canUseStorage()) {
    return "";
  }
  return window.localStorage.getItem(baselineStorageKey) || "";
}

export function setStoredTargetBaselineId(targetBaselineId) {
  if (!canUseStorage()) {
    return;
  }
  if (targetBaselineId) {
    window.localStorage.setItem(baselineStorageKey, targetBaselineId);
    return;
  }
  window.localStorage.removeItem(baselineStorageKey);
}
