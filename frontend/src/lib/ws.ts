const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

/**
 * Base URL of the live-data WebSocket server (no trailing slash).
 * NEXT_PUBLIC_WS_URL wins when set (e.g. "wss://api.example.com:9000");
 * otherwise it is NEXT_PUBLIC_API_URL with http→ws / https→wss and the port
 * replaced by NEXT_PUBLIC_WS_PORT (default 9000, matching the backend WS_PORT).
 */
export function wsBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const u = new URL(API_URL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.port = process.env.NEXT_PUBLIC_WS_PORT || "9000";
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}
