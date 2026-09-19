/* Shared jsdom harness for the frontend regression tests.
 *
 * Each *.test.mjs file wires a fresh JSDOM window into Node's globals and
 * then imports the real page module from ../../js/ — no bundling, no
 * mocking of the modules under test (only WebSocket + fetch are stubbed).
 */

import { JSDOM } from "jsdom";

const GLOBAL_KEYS = [
  "window", "document", "location", "history", "localStorage",
  "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent",
  "PopStateEvent", "DOMParser", "Element", "HTMLElement",
  "requestAnimationFrame", "getComputedStyle", "navigator",
];

/** Expose jsdom's window objects on Node's globals so app modules run unchanged.
 *  Accepts either the JSDOM instance or its window. Returns the window. */
export function wireGlobals(target) {
  const window = target.window ?? target;
  for (const key of GLOBAL_KEYS) {
    if (window[key] === undefined) continue;
    try {
      globalThis[key] = window[key];
    } catch {
      // Node marks some globals (e.g. navigator) read-only — override instead.
      Object.defineProperty(globalThis, key, {
        value: window[key], configurable: true, writable: true,
      });
    }
  }
  return window;
}

export function makeDom(bodyHtml, url) {
  return new JSDOM(`<!doctype html><html><head></head><body>${bodyHtml}</body></html>`, {
    url,
    pretendToBeVisual: true, // enables requestAnimationFrame
  });
}

/** Import a real app module by name from the js/ directory. */
export function importAppModule(name) {
  const href = new URL(`../../js/${name}`, import.meta.url).href;
  return import(href);
}

/** Poll until fn() returns true; throws with `label` after `timeoutMs`. */
export async function waitFor(fn, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * WebSocket double that mimics browser ordering: open fires via microtask
 * after construction, and close() delivers a close event (code 1005 when
 * called without arguments) — so app code sees the same sequence as with
 * a real server. close() is idempotent, like the real thing.
 */
export class FakeWebSocket {
  static instances = [];
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = {};
    this.closeArgs = null;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send() {}
  close(code, reason) {
    if (this.closeArgs) return;
    this.closeArgs = [code, reason];
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code: code ?? 1005, reason: reason ?? "" }));
  }
  emit(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
}

export function resetWebSockets() { FakeWebSocket.instances = []; }

/** Stub global fetch with a per-path handler; records every call. */
export function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { method: init.method || "GET", url: String(url) };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

function jsonResponse(body) {
  return {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

export { jsonResponse };
