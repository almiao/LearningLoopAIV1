const userIdStorageKey = "learning-loop-user-id";

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
