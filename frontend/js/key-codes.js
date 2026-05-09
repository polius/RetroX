/* key-codes.js — translate between three keyboard key vocabularies.
 *
 * RetroX persists rebinds as KeyboardEvent.code (e.g. "KeyZ") so they're
 * layout-independent — a German QWERTZ user picking "Y" still gets KeyY.
 * EmulatorJS's defaultControllers wants its own lowercase string vocab
 * (e.g. "z", "up arrow", "f2") that it later resolves to legacy numeric
 * keyCodes via its internal keyMap (see docker/emulatorjs/src/emulator.js).
 * The user sees a third vocab — short, friendly labels in the rebind UI.
 *
 * One module owns all three so the conversions never drift apart.
 */

// KeyboardEvent.code → EJS keyMap value. Keys not in this map are unbindable
// (the rebind UI rejects the capture). The set intentionally excludes bare
// modifiers, OS keys, media keys, IME, and function keys past F12 — none
// have an EJS keyMap entry, so they couldn't be applied to game inputs even
// if we accepted them for shortcuts.
const CODE_TO_EJS = Object.freeze({
  // Letters
  KeyA: "a", KeyB: "b", KeyC: "c", KeyD: "d", KeyE: "e", KeyF: "f",
  KeyG: "g", KeyH: "h", KeyI: "i", KeyJ: "j", KeyK: "k", KeyL: "l",
  KeyM: "m", KeyN: "n", KeyO: "o", KeyP: "p", KeyQ: "q", KeyR: "r",
  KeyS: "s", KeyT: "t", KeyU: "u", KeyV: "v", KeyW: "w", KeyX: "x",
  KeyY: "y", KeyZ: "z",
  // Top-row digits
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  // Numpad
  Numpad0: "numpad 0", Numpad1: "numpad 1", Numpad2: "numpad 2",
  Numpad3: "numpad 3", Numpad4: "numpad 4", Numpad5: "numpad 5",
  Numpad6: "numpad 6", Numpad7: "numpad 7", Numpad8: "numpad 8",
  Numpad9: "numpad 9",
  NumpadMultiply: "multiply", NumpadAdd: "add", NumpadSubtract: "subtract",
  NumpadDecimal: "decimal point", NumpadDivide: "divide",
  // Arrows
  ArrowUp: "up arrow", ArrowDown: "down arrow",
  ArrowLeft: "left arrow", ArrowRight: "right arrow",
  // Whitespace / control
  Space: "space", Enter: "enter", Tab: "tab",
  Escape: "escape", Backspace: "backspace",
  // Editing / nav
  Insert: "insert", Delete: "delete",
  Home: "home", End: "end", PageUp: "page up", PageDown: "page down",
  // Locks
  CapsLock: "caps lock", NumLock: "num lock", ScrollLock: "scroll lock",
  Pause: "pause/break",
  // Function row (EJS keyMap stops at F12)
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
  // Punctuation. "close braket" matches EJS's typo on purpose — see keyMap.
  Semicolon: "semi-colon", Equal: "equal sign", Comma: "comma",
  Minus: "dash", Period: "period", Slash: "forward slash",
  Backquote: "grave accent", BracketLeft: "open bracket",
  Backslash: "back slash", BracketRight: "close braket", Quote: "single quote",
});

// Friendly display labels for the rebind UI. Anything not in this map falls
// back to a derived label (Letter, Digit, function-key passthrough).
const CODE_TO_LABEL = Object.freeze({
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Space: "Space", Enter: "Enter", Tab: "Tab",
  Escape: "Esc", Backspace: "Backspace",
  Insert: "Ins", Delete: "Del",
  Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn",
  CapsLock: "Caps", NumLock: "NumLk", ScrollLock: "ScrLk", Pause: "Pause",
  Semicolon: ";", Equal: "=", Comma: ",", Minus: "-", Period: ".",
  Slash: "/", Backquote: "`", BracketLeft: "[",
  Backslash: "\\", BracketRight: "]", Quote: "'",
  NumpadMultiply: "Num *", NumpadAdd: "Num +", NumpadSubtract: "Num -",
  NumpadDecimal: "Num .", NumpadDivide: "Num /",
});

/**
 * True if a code can be bound — i.e. the converter knows how to translate
 * it for both EJS and the user-facing label. Use this to gate capture.
 */
export function isBindable(code) {
  return typeof code === "string" && code in CODE_TO_EJS;
}

/**
 * KeyboardEvent.code → EmulatorJS keyMap string. Returns null for unknown
 * codes; callers should use isBindable() first.
 */
export function codeToEjsKey(code) {
  return CODE_TO_EJS[code] ?? null;
}

/**
 * KeyboardEvent.code → short label for the rebind button. Always returns
 * a string; falls back to the raw code if nothing better is available.
 */
export function friendlyKey(code) {
  if (!code) return "";
  if (code in CODE_TO_LABEL) return CODE_TO_LABEL[code];
  if (code.startsWith("Key"))    return code.slice(3);
  if (code.startsWith("Digit"))  return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  if (/^F\d{1,2}$/.test(code))   return code;
  return code;
}
