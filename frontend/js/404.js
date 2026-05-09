/* 404 page — intentionally dependency-free (no modules) so it loads
 * even if a deploy/upgrade has broken module loading. Extracted from
 * an inline <script> block so a strict CSP (no 'unsafe-inline') can
 * be enforced.
 *
 * Esc as a silent affordance: most users won't think to press it,
 * but power users expect it and the lack of a visible hint keeps
 * the page calm. */
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    e.preventDefault();
    if (history.length > 1) history.back();
    else location.href = "/";
  } else if (e.key === "Enter") {
    e.preventDefault();
    location.href = "/";
  }
});
