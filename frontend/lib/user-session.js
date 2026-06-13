import { postJson } from "./api";

const userIdStorageKey = "learning-loop-user-id";
const localProfileHandleStorageKey = "learning-loop-local-profile-handle";
const localProfileHandle = "local_profile";
const localProfilePin = "0000";
let localProfilePromise = null;

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

function getLocalProfileHandle() {
  if (!canUseStorage()) {
    return localProfileHandle;
  }
  return window.localStorage.getItem(localProfileHandleStorageKey) || localProfileHandle;
}

function setLocalProfileHandle(handle) {
  if (canUseStorage() && handle) {
    window.localStorage.setItem(localProfileHandleStorageKey, handle);
  }
}

function createFallbackLocalProfileHandle() {
  return `local_profile_${Date.now().toString(36)}`;
}

export async function ensureLocalUserProfile() {
  const storedUserId = getStoredUserId();
  if (storedUserId) {
    return { user: { id: storedUserId, handle: "本机档案" } };
  }

  if (!localProfilePromise) {
    const handle = getLocalProfileHandle();
    localProfilePromise = postJson("/api/auth/login", {
      handle,
      pin: localProfilePin,
    })
      .then((data) => {
        const profile = data?.profile || null;
        setStoredUserId(profile?.user?.id || "");
        setLocalProfileHandle(profile?.user?.handle || handle);
        return profile;
      })
      .catch((error) => {
        const message = String(error?.message || "");
        if (handle !== localProfileHandle || !message.includes("PIN")) {
          throw error;
        }
        const fallbackHandle = createFallbackLocalProfileHandle();
        return postJson("/api/auth/login", {
          handle: fallbackHandle,
          pin: localProfilePin,
        }).then((data) => {
          const profile = data?.profile || null;
          setStoredUserId(profile?.user?.id || "");
          setLocalProfileHandle(profile?.user?.handle || fallbackHandle);
          return profile;
        });
      })
      .finally(() => {
        localProfilePromise = null;
      });
  }

  return localProfilePromise;
}

export async function ensureLocalUserId() {
  const profile = await ensureLocalUserProfile();
  return profile?.user?.id || getStoredUserId();
}
