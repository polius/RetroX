/* Custom-styled file input.
 *
 * Builds an HTML element wrapping a hidden <input type="file">. Callers can
 * read the chosen File via .file getter or pass an onChange callback. */

import { icon } from "./icons.js";

let serial = 0;

export function createFilePicker({ id, accept = "", placeholder = "No file chosen", buttonLabel = "Choose", onChange } = {}) {
  const inputId = id || `fp-${++serial}`;
  const wrap = document.createElement("div");
  wrap.className = "file-picker";
  wrap.innerHTML = `
    <input type="file" id="${inputId}"${accept ? ` accept="${accept}"` : ""}/>
    <label class="file-picker__face" for="${inputId}">
      <span class="file-picker__icon">${icon("upload", { size: 18 })}</span>
      <span class="file-picker__name"></span>
    </label>
    <button type="button" class="file-picker__clear" aria-label="Clear file">${icon("x", { size: 14 })}</button>
    <label class="file-picker__btn" for="${inputId}">${buttonLabel}</label>
  `;
  const input = wrap.querySelector("input[type=file]");
  const name = wrap.querySelector(".file-picker__name");
  const clear = wrap.querySelector(".file-picker__clear");
  name.textContent = placeholder;

  function update() {
    const f = input.files && input.files[0];
    if (f) {
      wrap.classList.add("has-file");
      name.textContent = f.name;
    } else {
      wrap.classList.remove("has-file");
      name.textContent = placeholder;
    }
    if (onChange) onChange(f || null);
  }
  input.addEventListener("change", update);
  clear.addEventListener("click", (e) => {
    e.preventDefault();
    input.value = "";
    update();
  });

  return {
    el: wrap,
    get file() { return input.files && input.files[0] || null; },
    reset() { input.value = ""; update(); },
  };
}
