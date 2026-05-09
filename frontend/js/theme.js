/* Theme + TV mode preference.
 * One locked dark theme — no theme variants. Only TV mode is user-controllable.
 * Local-first: read from localStorage immediately, then sync with backend. */

import { api } from "./api.js";

const KEY_TV = "retrox.tv";

function getTV() {
  return localStorage.getItem(KEY_TV) === "true";
}
function setTV(on) {
  localStorage.setItem(KEY_TV, on ? "true" : "false");
  document.documentElement.dataset.tv = on ? "true" : "false";
}

/** Apply locally-cached preferences immediately (before any network). */
export function applyEarly() {
  document.documentElement.dataset.tv = getTV() ? "true" : "false";
}

/** Hydrate from server preferences. Backend stores `tv_mode` (bool). */
export async function hydrate() {
  try {
    const prefs = await api.get("/profile/preferences");
    if (prefs && typeof prefs.tv_mode === "boolean") setTV(prefs.tv_mode);
  } catch { /* not signed in or backend unavailable — local value stands */ }
}

/** Toggle TV mode and persist. PUT /profile/preferences expects { data: {...} }
 *  and whitelists tv_mode. Optimistic — rolls back on failure. */
export async function toggleTV(next) {
  const prev = getTV();
  const value = typeof next === "boolean" ? next : !prev;
  setTV(value);
  try {
    await api.put("/profile/preferences", { data: { tv_mode: value } });
  } catch (err) {
    setTV(prev);
    throw err;
  }
}

export const tv = { get: getTV, set: setTV };
