/* Lucide-style line icons rendered inline. Single source of truth so
 * every page reaches for the same glyphs. */

import { escapeHtml } from "./util.js";

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  library: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  star: '<path d="M12 3l2.6 5.7 6.2.6-4.7 4.3 1.4 6.2L12 16.9 6.5 19.8l1.4-6.2L3.2 9.3l6.2-.6Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cartridge: '<path d="M5 6h10l4 4v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><rect x="7" y="9" width="8" height="3" rx="0.5"/><path d="M7 16h8"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  shuffle: '<path d="m16 3 4 4-4 4"/><path d="M4 7h4l8 10h4"/><path d="m16 21 4-4-4-4"/><path d="M4 17h4"/>',
  play: '<path d="M6 4v16l13-8Z" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 21 10c0 5.6-7 10-7 10Z"/>',
  heartFilled: '<path fill="currentColor" stroke="currentColor" d="M12 20s-7-4.4-7-10a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 21 10c0 5.6-9 10-9 10Z"/>',
  chevronRight: '<polyline points="9 6 15 12 9 18"/>',
  chevronLeft: '<polyline points="15 6 9 12 15 18"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronUp: '<polyline points="18 15 12 9 6 15"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<path d="m21 18-9-15-9 15Z"/><path d="M12 9v4M12 17h.01"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  edit: '<path d="M11 5H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7"/><path d="m18.4 2.6 3 3-9.4 9.4-3.6.6.6-3.6Z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10"/><path d="M1 14l4.7 4.4A9 9 0 0 0 20.5 15"/>',
  qr: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M15 15h2v2h-2zM19 15h2v2h-2zM15 19h2v2h-2zM19 19h2v2h-2z" fill="currentColor" stroke="none"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m22 5-9.4 9.4"/><path d="m17 8 3 3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  game: '<path d="M6 12h4M8 10v4M15 11h.01M18 13h.01"/><rect x="2" y="6" width="20" height="12" rx="3"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="0.9" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="0.9" fill="currentColor" stroke="none"/><circle cx="3" cy="18" r="0.9" fill="currentColor" stroke="none"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
};

/** Build an inline SVG element from the icon registry. */
export function icon(name, { size = 18, className = "", strokeWidth = 1.8, ariaLabel = null } = {}) {
  const path = ICONS[name];
  if (!path) {
    console.warn(`icon "${name}" not found`);
    return "";
  }
  // ariaLabel and className may flow from arbitrary call sites — escape
  // before interpolating so no caller can accidentally inject markup.
  const ariaAttr = ariaLabel
    ? `role="img" aria-label="${escapeHtml(ariaLabel)}"`
    : 'aria-hidden="true"';
  // Only emit `class=` when a className is supplied. An empty class
  // attribute can trip SVG-namespacing edge cases on older Safari
  // builds, and skipping it keeps the rendered markup clean.
  const classAttr = className ? ` class="${escapeHtml(className)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${classAttr} ${ariaAttr}>${path}</svg>`;
}
