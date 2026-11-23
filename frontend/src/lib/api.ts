import { clearSession, getSession, refreshSession, type Session } from "./auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

function bearer(session: Session | null): Record<string, string> {
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

/**
 * fetch with the access token attached. On a 401 it refreshes the session once
 * and retries; if that fails too the session is cleared (back to /login).
 */
async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const send = (session: Session | null) =>
    fetch(`${API_URL}${path}`, {
      ...options,
      headers: { ...bearer(session), ...(options.headers || {}) },
    });

  const session = await getSession();
  let res = await send(session);
  if (res.status === 401 && session) {
    const next = await refreshSession();
    if (next && next.access_token !== session.access_token) res = await send(next);
    if (res.status === 401) clearSession();
  }
  return res;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await authFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Authenticated file download (e.g. CSV export). Saves via a temporary link. */
async function download(path: string, fallbackName = "download"): Promise<{ truncated: boolean }> {
  const res = await authFetch(path);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Download failed");
  }
  const disposition = res.headers.get("Content-Disposition") || "";
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] || fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { truncated: res.headers.get("X-Truncated") === "true" };
}

export const api = {
  download,
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "DELETE",
      body: body ? JSON.stringify(body) : undefined,
    }),
};
