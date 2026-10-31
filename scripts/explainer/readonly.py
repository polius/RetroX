"""A read-only browser for a live RetroX instance.

The film shows a real, signed-in RetroX, so footage is recorded against a live
server. Nothing the recording does may change it: no saves, no playtime, no
favourites, no settings. Every context opened here enforces that twice:

  * at the network layer, any request that isn't GET or HEAD is aborted
    (except the session refresh, which only rotates our own cookie);
  * in the page, fetch / XHR / sendBeacon refuse writes before they are sent,
    and WebSockets (the phone-controller pairing) are disabled.

Aborted writes are logged, so a run reports exactly what the app *tried* to do.
"""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, ".auth", "state.json")
BASE_FILE = os.path.join(HERE, ".auth", "base.txt")

ALLOWED_WRITE = ("/api/auth/refresh",)

GUARD = r"""
(() => {
  const allowed = %s;
  const ok = (method, url) => {
    method = String(method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return true;
    try { url = new URL(url, location.href).pathname; } catch { url = String(url); }
    return allowed.some((p) => url.startsWith(p));
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const method = init.method || (input instanceof Request ? input.method : 'GET');
    const url = input instanceof Request ? input.url : input;
    if (!ok(method, url)) {
      console.warn('[readonly] blocked', method, String(url));
      return Promise.reject(new TypeError('read-only recording'));
    }
    return realFetch(input, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ro = ok(method, url);
    if (!this.__ro) console.warn('[readonly] blocked', method, String(url));
    return open.call(this, method, url, ...rest);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    if (this.__ro === false) { this.abort(); return; }
    return send.apply(this, a);
  };
  navigator.sendBeacon = (url) => { console.warn('[readonly] blocked beacon', String(url)); return true; };
  window.WebSocket = function () { throw new Error('read-only recording: no sockets'); };
})();
""" % json.dumps(list(ALLOWED_WRITE))


def base_url():
    with open(BASE_FILE) as f:
        return f.read().strip().rstrip("/")


def guard(ctx, log):
    """Install both layers of the read-only guard on a browser context."""
    ctx.add_init_script(GUARD)

    def route(r):
        req = r.request
        path = req.url.split("?")[0]
        if req.method in ("GET", "HEAD") or any(p in path for p in ALLOWED_WRITE):
            return r.continue_()
        log.append(f"{req.method} {path}")
        return r.abort()

    ctx.route("**/*", route)
    return ctx


def context(browser, log, **kw):
    """A signed-in, read-only context. Keyword args go to new_context."""
    ctx = browser.new_context(storage_state=STATE, **kw)
    return guard(ctx, log)


def keep_session(ctx):
    """Persist the (possibly refreshed) session for the next run."""
    ctx.storage_state(path=STATE)
    os.chmod(STATE, 0o600)
