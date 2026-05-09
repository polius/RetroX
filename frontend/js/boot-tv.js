/* Earliest-possible TV-mode bootstrap. Loaded as a non-module
 * <script src> so it executes before deferred modules and before
 * paint, which prevents FOUC when TV-mode CSS rules are scoped
 * to [data-tv="true"]. Extracted from inline <script> blocks so
 * a strict CSP (no 'unsafe-inline') can be enforced. */
try {
  document.documentElement.dataset.tv =
    localStorage.getItem("retrox.tv") === "true" ? "true" : "false";
} catch { /* localStorage unavailable — leave default */ }
