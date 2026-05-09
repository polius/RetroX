/* Tiny fetch wrapper for /api/*.
 *
 * - Cookies are sent automatically (sessions are HttpOnly).
 * - 401 responses transparently attempt /api/auth/refresh once before
 *   redirecting to /login. Every authenticated request is retried at
 *   most once after a successful refresh — concurrent 401s coalesce
 *   onto a single in-flight refresh promise so we never stampede.
 * - JSON helpers parse/serialise; raw helpers stream files. */

const BASE = "/api";
const REFRESH_PATH = "/auth/refresh";

function isAuthPage() {
  const p = location.pathname;
  return p === "/login" || p.endsWith("/login.html");
}

class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "APIError";
    this.status = status;
  }
}

/* --------------------------------------------------------------------
 * Refresh coalescing
 *
 * Two parallel /games requests both 401 → we want one /refresh, not
 * two. Subsequent callers reuse the in-flight promise; the result is
 * a single boolean ("did the refresh succeed?") that all retriers
 * branch on.
 * ------------------------------------------------------------------ */

let _refreshPromise = null;

async function performRefresh() {
  try {
    const r = await fetch(BASE + REFRESH_PATH, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return r.ok;
  } catch {
    return false;
  }
}

function refreshOnce() {
  if (!_refreshPromise) {
    _refreshPromise = performRefresh().finally(() => { _refreshPromise = null; });
  }
  return _refreshPromise;
}

function isRefreshPath(path) {
  // The auto-refresh logic should kick in for *every* authenticated
  // endpoint, including /auth/me and /auth/qr/* — those are the
  // canonical "am I still signed in?" / "approve this device" probes,
  // and silently logging the user out instead of trying their valid
  // long-lived refresh cookie defeats the entire short-access /
  // long-refresh design.
  //
  // Only these specific paths are exempt:
  //   - /auth/refresh would recurse into itself.
  //   - /auth/login and /auth/login/2fa carry credential-error 401s
  //     that the caller must see directly; looping through /refresh
  //     would just produce another 401 without changing anything.
  //   - /auth/logout is mid-flight clearing the cookies; refreshing
  //     them back is paradoxical.
  if (path === REFRESH_PATH) return true;
  return path === "/auth/login"
      || path === "/auth/login/2fa"
      || path === "/auth/logout";
}

// Rate-limit listeners. Callback registry (over a dynamic import of
// toast.js or a custom event) keeps api.js dependency-free — toast.js
// transitively imports icons/input-mode, which we don't want pulled
// into the lowest-level fetch wrapper. shell.js wires the toast at boot.
const _rateLimitListeners = new Set();
function _notifyRateLimit(retryAfter) {
  for (const fn of _rateLimitListeners) {
    try { fn(retryAfter); } catch (e) { console.warn("[api] rate-limit listener threw", e); }
  }
}

async function fetchWithRefresh(path, init) {
  let r = await fetch(BASE + path, init);
  if (r.status === 401 && !isRefreshPath(path)) {
    const ok = await refreshOnce();
    if (ok) {
      r = await fetch(BASE + path, init);
    }
  }
  if (r.status === 429) {
    const retryAfter = parseInt(r.headers.get("retry-after") || "60", 10);
    _notifyRateLimit(Number.isFinite(retryAfter) ? retryAfter : 60);
  }
  return r;
}

/* FastAPI returns 422s as `{ detail: [{ loc, msg, type, ... }] }`.
 * Stringifying that for the toast leaks the schema shape ("[{type:
 * 'string_too_short', loc: ['body','password'], msg: '...'}]") which
 * is unreadable. Format each entry as "<field>: <msg>" so the toast
 * shows e.g. "password: String should have at least 8 characters". */
function formatDetail(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map(e => {
      const msg = e && e.msg ? String(e.msg) : "";
      const loc = e && Array.isArray(e.loc) ? e.loc.filter(p => p !== "body") : [];
      const field = loc.length ? loc[loc.length - 1] : null;
      if (field && msg) return `${field}: ${msg}`;
      return msg || JSON.stringify(e);
    }).join("\n");
  }
  return JSON.stringify(detail);
}

async function handle(response) {
  if (response.status === 401) {
    if (!isAuthPage()) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `/login?next=${next}`;
    }
    throw new APIError("Not authenticated", 401);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const data = await response.json();
      if (data && data.detail) {
        message = formatDetail(data.detail);
      }
    } catch (e) {
      // Body isn't JSON or already consumed. Surface in dev tools so
      // a malformed error response can be diagnosed without dropping
      // the user-visible message.
      console.warn("[api] failed to parse error body", e);
    }
    throw new APIError(message, response.status);
  }
  return response;
}

async function json(method, path, body) {
  const init = { method, credentials: "include", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await handle(await fetchWithRefresh(path, init));
  if (r.status === 204) return null;
  return r.json();
}

async function upload(path, formData, { method = "POST", headers } = {}) {
  const init = { method, credentials: "include", body: formData, headers: headers || {} };
  const r = await handle(await fetchWithRefresh(path, init));
  if (r.status === 204) return null;
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : null;
}

async function raw(path, init = {}) {
  init.credentials = "include";
  return handle(await fetchWithRefresh(path, init));
}

// Binary PUT through fetchWithRefresh that returns the raw Response
// (no JSON parse, no `handle()` redirect on 401). Separate from
// `upload` because the save-persistor needs status + headers and
// must distinguish 409 vs 401 vs other failures itself.
async function rawPut(path, body, headers) {
  const init = { method: "PUT", credentials: "include", body, headers: headers || {} };
  return fetchWithRefresh(path, init);
}

async function del(path, headers) {
  const init = { method: "DELETE", credentials: "include" };
  if (headers) init.headers = headers;
  const r = await handle(await fetchWithRefresh(path, init));
  return r.status === 204 ? null : r.json();
}

function url(path) { return BASE + path; }

export const api = {
  get:   (p) => json("GET", p),
  post:  (p, b) => json("POST", p, b),
  put:   (p, b) => json("PUT", p, b),
  patch: (p, b) => json("PATCH", p, b),
  del,
  upload,
  raw,
  rawPut,
  url,
  onRateLimit(fn) { _rateLimitListeners.add(fn); return () => _rateLimitListeners.delete(fn); },
  APIError,
};

// Legacy global for inline script blocks that may need it.
window.api = api;
