const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:4000";

export async function apiFetch(pathname, options = {}) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    cache: "no-store"
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

export async function postJson(pathname, payload) {
  return apiFetch(pathname, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
