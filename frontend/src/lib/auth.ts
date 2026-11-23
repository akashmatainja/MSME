// Browser auth client for the backend's /auth endpoints.
// The session lives in localStorage and is shared by all tabs; the access token
// is refreshed shortly before it expires.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";
const STORAGE_KEY = "fsid.auth.session";
const REFRESH_MARGIN_S = 60;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
  user: AuthUser;
}

type Listener = (session: Session | null) => void;

export class AuthError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const listeners = new Set<Listener>();
let refreshing: Promise<Session | null> | null = null;

function read(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function write(session: Session | null) {
  try {
    if (session) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode): session lasts for this page only
  }
  listeners.forEach((l) => l(session));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new AuthError(err.error || "Request failed", res.status);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

async function doRefresh(current: Session): Promise<Session | null> {
  try {
    const next = await post<Session>("/auth/refresh", { refresh_token: current.refresh_token });
    write(next);
    return next;
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) {
      // Another tab may have rotated the token first: use its session.
      const stored = read();
      if (stored && stored.refresh_token !== current.refresh_token) return stored;
      write(null);
      return null;
    }
    // Network or server error: keep the session and try again later.
    return current;
  }
}

/** Refreshes the session now (single request even if called concurrently). */
export function refreshSession(): Promise<Session | null> {
  const current = read();
  if (!current) return Promise.resolve(null);
  if (!refreshing) {
    refreshing = doRefresh(current).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

/** Current session, refreshed first if the access token is about to expire. */
export async function getSession(): Promise<Session | null> {
  const s = read();
  if (!s) return null;
  if (s.expires_at - Date.now() / 1000 > REFRESH_MARGIN_S) return s;
  return refreshSession();
}

export async function signIn(email: string, password: string): Promise<Session> {
  const session = await post<Session>("/auth/login", { email, password });
  write(session);
  return session;
}

/** Stores a session returned by the backend (e.g. after a password change). */
export function setSession(session: Session) {
  write(session);
}

export async function signOut(): Promise<void> {
  const s = read();
  write(null);
  if (s) await post("/auth/logout", { refresh_token: s.refresh_token }).catch(() => {});
}

/** Clears the local session without calling the backend. */
export function clearSession() {
  write(null);
}

/** Subscribes to sign-in/sign-out in this tab and in other tabs. */
export function onAuthStateChange(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener(read());
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
