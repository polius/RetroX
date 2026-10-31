/* RetroX film — deterministic render engine.
 *
 * Everything on screen is a pure function of the video timestamp t. The capture
 * harness calls window.__render(t) once per frame and screenshots the page; no
 * wall-clock animation is ever used, so every frame is reproducible. When a
 * frame swaps an image (a gameplay frame, a scroll position), __render returns
 * a promise that settles once the new image is decoded, and the harness waits.
 *
 * Scenes register into window.SCENES (see scenes.js). Each gets its own layer
 * with an inner camera; the engine owns the cuts between layers (a wall of
 * pixels that builds and breaks), the LCD dot-field background, the CRT
 * power-on/off, the arcade HUD, the accent colour, and the sound-effect cues.
 */
(function () {
  const SCENES = (window.SCENES = {});

  // ---- math / easing ------------------------------------------------------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ramp = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a)));
  const outQuint = (t) => 1 - Math.pow(1 - clamp(t), 5);
  const outCubic = (t) => 1 - Math.pow(1 - clamp(t), 3);
  const outExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t)));
  const inCubic = (t) => Math.pow(clamp(t), 3);
  const inOutCubic = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const inOutSine = (t) => -(Math.cos(Math.PI * clamp(t)) - 1) / 2;
  const outBack = (t, s = 1.4) => { t = clamp(t); return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); };
  const spring = (t, k = 7, z = 5) => (t <= 0 ? 0 : 1 - Math.exp(-z * t) * Math.cos(k * t));
  // quantize a 0..1 progress into n steps: motion that moves like a sprite
  const steps = (p, n) => Math.floor(clamp(p) * n) / n;

  // seeded noise, so "random" things are identical on every render
  function rnd(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  /* fade + rise (+ scale, + a short de-blur) from p = 0..1 */
  function reveal(node, p, o = {}) {
    if (!node) return p;
    const e = (o.ease || outQuint)(p);
    if (p <= 0) { node.style.visibility = "hidden"; return p; }
    node.style.visibility = "visible";
    node.style.opacity = clamp(e * (o.alpha ?? 1)).toFixed(4);
    const dy = (o.dy ?? 30) * (1 - e), dx = (o.dx ?? 0) * (1 - e);
    const sc = lerp(o.scale ?? 1, 1, e);
    const base = o.base || "";
    node.style.transform = `${base} translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${sc.toFixed(4)})`;
    const bl = (o.blur ?? 0) * (1 - e);
    node.style.filter = bl > 0.3 ? `blur(${bl.toFixed(2)}px)` : "none";
    return p;
  }
  function hide(node) { node.style.visibility = "hidden"; }
  function show(node, on) { node.style.visibility = on ? "visible" : "hidden"; }

  // ---- DOM helpers ----------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, cls, parent, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    if (parent) parent.appendChild(n);
    return n;
  }
  function svg(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  /* centre-anchored box at (x, y); its own transform stays free for reveal() */
  function at(parent, x, y, cls, html) {
    const wrap = el("div", "ctr", parent);
    wrap.style.left = x + "px"; wrap.style.top = y + "px";
    return el("div", cls || "", wrap, html);
  }
  function box(parent, x, y, w, h, cls) {
    const n = el("div", "abs " + (cls || ""), parent);
    Object.assign(n.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    return n;
  }
  const cache = new WeakMap();
  function setText(node, s) { if (cache.get(node) !== s) { node.textContent = s; cache.set(node, s); } }
  function setHTML(node, s) { if (cache.get(node) !== s) { node.innerHTML = s; cache.set(node, s); } }

  /* kinetic words: split `text` into masked words. Returns the inner spans. */
  function words(parent, text, wordCls) {
    return text.split(" ").map((w, i, all) => {
      const k = el("span", "kt", parent);
      const s = el("span", wordCls || "", k);
      s.textContent = w;
      if (i < all.length - 1) parent.appendChild(document.createTextNode(" "));
      return s;
    });
  }
  /* rise each word out of its mask, staggered, starting at t0 */
  function kin(spans, t, t0, stagger = 0.06, dur = 0.5, out = null) {
    spans.forEach((s, i) => {
      const p = outQuint(ramp(t, t0 + i * stagger, t0 + i * stagger + dur));
      let y = (1 - p) * 120;
      if (out != null) {
        const q = inCubic(ramp(t, out + i * stagger * 0.5, out + i * stagger * 0.5 + 0.3));
        y -= q * 120;
      }
      s.style.transform = `translateY(${y.toFixed(2)}%)`;
    });
  }

  // ---- images: every swap is awaited before the frame is captured ----------
  const PENDING = [];
  const WAIT = [];
  function setSrc(img, url) {
    if (img.dataset.src === url) return;
    img.dataset.src = url;
    img.src = url;
    PENDING.push(img.decode().catch(() => {}));
  }
  function image(parent, url, cls) {
    const img = el("img", cls || "", parent);
    img.decoding = "sync";
    img.dataset.src = url;
    img.src = url;
    WAIT.push(img.decode().catch(() => {}));
    return img;
  }
  /* a recorded sequence: frame k of `folder` at 60 fps, 1-based %05d.png */
  function seq(img, folder, count, fps = 60) {
    return (sec) => {
      const k = clamp(Math.floor(sec * fps), 0, count - 1) + 1;
      setSrc(img, `/app/gameplay/${folder}/${String(k).padStart(5, "0")}.png`);
    };
  }
  const GAMEPLAY = { intro: 1200, title: 1440, naming: 1680, town: 2760 };

  // ---- the pixel font: 5x7, drawn dot by dot -------------------------------
  const G = {
    A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110",
    C: "01110100011000010000100001000101110", D: "11110100011000110001100011000111110",
    E: "11111100001000011110100001000011111", F: "11111100001000011110100001000010000",
    G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001",
    I: "01110001000010000100001000010001110", J: "00111000100001000010000101001001100",
    K: "10001100101010011000101001001010001", L: "10000100001000010000100001000011111",
    M: "10001110111010110101100011000110001", N: "10001100011100110101100111000110001",
    O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000",
    Q: "01110100011000110001101011001001101", R: "11110100011000111110101001001010001",
    S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
    U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100",
    W: "10001100011000110101101011010101010", X: "10001100010101000100010101000110001",
    Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111",
    0: "01110100011001110101110011000101110", 1: "00100011000010000100001000010001110",
    2: "01110100010000100010001000100011111", 3: "11111000100010000010000011000101110",
    4: "00010001100101010010111110001000010", 5: "11111100001111000001000011000101110",
    6: "00110010001000011110100011000101110", 7: "11111000010001000100010000100001000",
    8: "01110100011000101110100011000101110", 9: "01110100011000101111000010001001100",
    ".": "00000000000000000000000000110001100", "-": "00000000000000011111000000000000000",
    "!": "00100001000010000100001000000000100", ":": "00000011000110000000011000110000000",
    "/": "00001000100001000100010000100010000", ">": "10000110001110011110111001100010000",
    "+": "00000001000010011111001000010000000", "'": "00100001000100000000000000000000000",
    "·": "00000000000000000100000000000000000",
  };
  /* text -> SVG of squares. dot = square size, colour per glyph via fn or string */
  function pixText(parent, text, o = {}) {
    const dot = o.dot || 8, gap = o.gap ?? 1, pitch = dot, cols = [];
    let x = 0;
    const cells = [];
    for (const ch of text.toUpperCase()) {
      if (ch === " ") { x += 4; continue; }
      const g = G[ch];
      if (!g) { x += 6; continue; }
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++)
        if (g[r * 5 + c] === "1") cells.push({ x: x + c, y: r, ch });
      x += 6;
    }
    const w = (x - 1) * pitch, h = 7 * pitch;
    const s = svg("svg", { class: "pix", width: w, height: h, viewBox: `0 0 ${w} ${h}` }, parent);
    const rects = cells.map((c, i) => {
      const fill = typeof o.color === "function" ? o.color(c, i) : (o.color || "currentColor");
      return Object.assign(svg("rect", { x: c.x * pitch, y: c.y * pitch, width: pitch - gap, height: pitch - gap, fill }, s), { cell: c });
    });
    return { node: s, rects, w, h };
  }
  /* a bitmap from rows of palette characters ('.' = empty) */
  const PAL = { a: "#e5a00d", w: "#f4f5f8", s: "#55698a", b: "#e06a7a", p: "#edb068",
                l: "#d3dbe5", d: "#20252e", g: "#34d399", k: "#0b0d11", c: "#38bdf8" };
  function pixArt(parent, rows, dot) {
    const w = rows[0].length * dot, h = rows.length * dot;
    const s = svg("svg", { class: "pix", width: w, height: h, viewBox: `0 0 ${w} ${h}` }, parent);
    const rects = [];
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === "." || ch === " ") return;
      rects.push(Object.assign(svg("rect", { x: x * dot, y: y * dot, width: dot, height: dot, fill: PAL[ch] || ch }, s), { cell: { x, y } }));
    }));
    return { node: s, rects, w, h };
  }
  /* sprite-like build: each square pops in on its own beat */
  function buildIn(rects, t, t0, dur, order = (c) => c.x * 0.6 + c.y) {
    const max = Math.max(1, ...rects.map((r) => order(r.cell)));
    rects.forEach((r, i) => {
      const k = order(r.cell) / max;
      const p = ramp(t, t0 + k * dur * 0.75, t0 + k * dur * 0.75 + dur * 0.25 + 0.02);
      r.setAttribute("opacity", p > 0 ? 1 : 0);
    });
  }

  const A = { clamp, lerp, ramp, rnd, outQuint, outCubic, outExpo, inCubic, inOutCubic, inOutSine,
              outBack, spring, steps, reveal, hide, show, el, svg, at, box, setText, setHTML, words, kin,
              image, setSrc, seq, GAMEPLAY, pixText, pixArt, buildIn, PAL };
  window.Toolkit = A;

  // ---- timeline, cues, accent ------------------------------------------------
  let TL = null;
  const CUES = [];                 // sound effects: { t, type, gain }
  const ACCENT_KEYS = [];          // { t, rgb }
  const PULSES = [];               // [t, gain, x, y]: a ripple of light through the dot field
  const HUD = [];                  // { start, end, label, node }
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const BRAND = "#e5a00d";

  function api(scene, layer, cam) {
    const t0 = scene.start;
    return Object.assign({
      tl: TL.d, scene, layer, cam, t0, W: 1920, H: 1080, data: DATA,
      dur: scene.end - scene.start,
      on: (id, label) => TL.byId[id].onsets[label] - t0,
      segStart: (id) => TL.byId[id].start - t0,
      segEnd: (id) => TL.byId[id].end - t0,
      cue: (type, t, gain = 1) => CUES.push({ t: +(t0 + t).toFixed(3), type, gain }),
      accent: (t, hex) => ACCENT_KEYS.push({ t: t0 + t, rgb: hex2rgb(hex) }),
      pulse: (t, gain = 1, x = 960, y = 540) => PULSES.push([t0 + t, gain, x, y]),
      hud: (label) => HUD.push({ start: scene.start, end: scene.end, label }),
    }, A);
  }

  function accentAt(t) {
    let c = hex2rgb(BRAND);
    for (const k of ACCENT_KEYS) {
      if (t < k.t) break;
      const p = inOutCubic(ramp(t, k.t, k.t + 0.6));
      c = c.map((v, i) => lerp(v, k.rgb[i], p));
    }
    return c;
  }

  // ---- background: an LCD dot field that light runs through ----------------
  const PITCH = 30, DOT = 4;
  let dctx = null, DPR = 1;
  function paintBackground(t, acc) {
    const bg = document.getElementById("bg");
    const g1 = bg.querySelector(".g1"), g2 = bg.querySelector(".g2");
    g1.style.transform = `translate(${(-500 + 180 * Math.sin(t * 0.12)).toFixed(1)}px, ${(-900 + 140 * Math.cos(t * 0.1)).toFixed(1)}px)`;
    g2.style.transform = `translate(${(1000 + 150 * Math.sin(t * 0.09 + 2)).toFixed(1)}px, ${(-60 + 120 * Math.sin(t * 0.07 + 1)).toFixed(1)}px)`;

    const c = dctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, 1920, 1080);
    const [r, g, b] = acc.map(Math.round);
    const live = PULSES.filter(([t0]) => t >= t0 - 0.05 && t < t0 + 2.6);
    // a slow diagonal shimmer, like light raking across an LCD
    for (let y = PITCH / 2; y < 1080; y += PITCH) {
      for (let x = PITCH / 2; x < 1920; x += PITCH) {
        let a = 0.05 + 0.035 * Math.max(0, Math.sin((x + y) * 0.004 - t * 0.9));
        for (const [t0, gain, px, py] of live) {
          const front = (t - t0) * 1500;
          const d = Math.hypot(x - px, y - py);
          a += gain * 0.55 * Math.exp(-(((d - front) / 90) ** 2)) * Math.exp(-(t - t0) * 0.9);
        }
        if (a < 0.02) continue;
        c.fillStyle = `rgba(${r},${g},${b},${Math.min(0.85, a).toFixed(3)})`;
        c.fillRect(x - DOT / 2, y - DOT / 2, DOT, DOT);
      }
    }
  }

  // ---- the cut: a wall of pixels builds, the scene swaps behind it, it breaks --
  const BLOCK = 60, BX = 1920 / BLOCK, BY = Math.ceil(1080 / BLOCK);
  const CUT_IN = 0.3, CUT_OUT = 0.34;
  let wctx = null;
  function paintWipe(t, acc) {
    const c = wctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, 1920, 1080);
    for (let i = 1; i < built.length; i++) {
      const s0 = built[i].scene.start;
      if (t < s0 - CUT_IN || t > s0 + CUT_OUT) continue;
      const dir = i % 2 ? 1 : -1;                     // alternate the sweep direction
      for (let y = 0; y < BY; y++) for (let x = 0; x < BX; x++) {
        const k = rnd(x * 31 + y * 17 + i * 7);
        const sweep = (dir > 0 ? x : BX - 1 - x) / BX;
        const d = clamp(sweep * 0.7 + k * 0.3);
        let s;
        if (t < s0) s = ramp(t, s0 - CUT_IN + d * CUT_IN * 0.7, s0 - CUT_IN + d * CUT_IN * 0.7 + CUT_IN * 0.3);
        else s = 1 - ramp(t, s0 + d * CUT_OUT * 0.7, s0 + d * CUT_OUT * 0.7 + CUT_OUT * 0.3);
        if (s <= 0) continue;
        const sz = BLOCK * steps(s, 4);
        if (sz <= 0) continue;
        const accentBlock = k > 0.86;
        c.fillStyle = accentBlock ? `rgb(${acc.map(Math.round).join(",")})` : (k > 0.6 ? "#11141a" : "#07090c");
        c.fillRect(x * BLOCK + (BLOCK - sz) / 2, y * BLOCK + (BLOCK - sz) / 2, sz, sz);
      }
    }
  }

  // ---- build + render -----------------------------------------------------------
  let built = null;
  let DATA = {};

  function build() {
    const root = document.getElementById("scenes");
    built = [];
    TL.scenes.forEach((scene, idx) => {
      const layer = el("div", "layer", root);
      layer.style.zIndex = 10 + idx;
      const cam = el("div", "cam", layer);
      ACCENT_KEYS.push({ t: scene.start, rgb: hex2rgb(BRAND) });
      const render = SCENES[scene.name](cam, api(scene, layer, cam));
      built.push({ scene, layer, render });
      if (idx > 0) {
        CUES.push({ t: +(scene.start - CUT_IN).toFixed(3), type: "wipe", gain: 1 });
        PULSES.push([scene.start, 1, 960, 540]);
      }
    });
    ACCENT_KEYS.sort((a, b) => a.t - b.t);
    CUES.sort((a, b) => a.t - b.t);
    // the HUD: a stage label per scene, typed in like an arcade banner
    const hud = document.getElementById("hud");
    HUD.forEach((h, i) => {
      const n = el("div", "abs", hud);
      Object.assign(n.style, { left: "64px", top: "52px" });
      const p = pixText(n, h.label, { dot: 5, gap: 1, color: (c) => (c.x < 6 * h.label.indexOf(" ") ? "#e5a00d" : "#a8acb6") });
      h.node = n; h.px = p;
      CUES.push({ t: +(h.start + 0.45).toFixed(3), type: "blip", gain: 0.5 });
    });
    CUES.sort((a, b) => a.t - b.t);
  }

  function paintHud(t) {
    for (const h of HUD) {
      const on = t >= h.start + 0.35 && t < h.end - 0.25;
      h.node.style.visibility = on ? "visible" : "hidden";
      if (!on) continue;
      const n = h.px.rects.length, k = Math.floor(ramp(t, h.start + 0.35, h.start + 0.75) * n);
      h.px.rects.forEach((r, i) => r.setAttribute("opacity", i < k ? 1 : 0));
      const out = ramp(t, h.end - 0.5, h.end - 0.25);
      h.node.style.opacity = (1 - out).toFixed(3);
    }
  }

  /* power on: a line of light opens into the picture. Power off: the
     picture folds into a line, the line into a dot, the dot goes out. */
  function paintCrt(t) {
    const [top, bot, beam] = document.getElementById("crt").children;
    const end = TL.d.video_end;
    let open, bw, ba;
    if (t < end / 2) {
      bw = outCubic(ramp(t, 0.1, 0.4));
      open = outExpo(ramp(t, 0.4, 0.85));
      ba = ramp(t, 0.1, 0.2) * (1 - ramp(t, 0.6, 0.9));
    } else {
      open = 1 - inCubic(ramp(t, end - 1.0, end - 0.7));
      bw = 1 - inCubic(ramp(t, end - 0.7, end - 0.42));
      ba = ramp(t, end - 0.95, end - 0.75) * (1 - ramp(t, end - 0.42, end - 0.3));
    }
    const h = (540 * (1 - open)).toFixed(1) + "px";
    top.style.top = "0"; top.style.height = h;
    bot.style.bottom = "0"; bot.style.height = h;
    beam.style.opacity = ba.toFixed(3);
    beam.style.transform = `scaleX(${Math.max(0.004, bw).toFixed(4)})`;
  }

  function render(t) {
    PENDING.length = 0;
    const acc = accentAt(t);
    const rs = document.documentElement.style;
    rs.setProperty("--accent", `rgb(${acc.map(Math.round).join(",")})`);
    rs.setProperty("--accent-l", `rgb(${acc.map((v) => Math.round(lerp(v, 255, 0.4))).join(",")})`);
    paintBackground(t, acc);

    for (let i = 0; i < built.length; i++) {
      const { scene: s, layer, render: r } = built[i];
      const first = i === 0, last = i === built.length - 1;
      // hard swap behind the pixel wall, plus a little push on either side
      const visible = (first || t >= s.start) && (last || t < s.end);
      const preview = !visible && t >= s.start - CUT_IN && t < s.start;   // pre-render under the wall
      if (!visible && !preview) { layer.style.display = "none"; continue; }
      layer.style.display = preview ? "none" : "";
      const inP = first ? 1 : ramp(t, s.start, s.start + 0.6);
      const outP = last ? 0 : ramp(t, s.end - CUT_IN, s.end);
      const sc = lerp(1.06, 1, outCubic(inP)) * lerp(1, 0.96, inCubic(outP));
      layer.style.transform = `scale(${sc.toFixed(5)})`;
      r(t - s.start, t);
    }
    paintWipe(t, acc);
    paintHud(t);
    paintCrt(t);
    return PENDING.length ? Promise.all(PENDING).then(() => true) : true;
  }

  // ---- capture API --------------------------------------------------------------
  window.__init = async function (data) {
    const byId = {};
    data.segments.forEach((s) => (byId[s.id] = s));
    TL = { d: data, byId, scenes: data.scenes };
    const get = async (u) => (await fetch(u)).json();
    DATA = { games: await get("/app/games.json"), shots: await get("/app/shots.json") };
    DPR = window.devicePixelRatio || 1;
    for (const id of ["dots", "wipe"]) {
      const cv = document.getElementById(id);
      cv.width = 1920 * DPR; cv.height = 1080 * DPR;
    }
    dctx = document.getElementById("dots").getContext("2d");
    wctx = document.getElementById("wipe").getContext("2d");
    const crt = document.getElementById("crt");
    el("div", "lid", crt); el("div", "lid", crt); el("div", "beam", crt);
    build();
    window.__ready = Promise.all([
      document.fonts.load('700 112px "Space Grotesk"'),
      document.fonts.load('500 34px "Inter"'),
      document.fonts.load('600 20px "Inter"'),
      document.fonts.load('500 30px "JetBrains Mono"'),
      ...WAIT,
    ]).then(() => document.fonts.ready).then(() => true);
  };
  window.__render = render;
  window.__cues = () => CUES;
  window.__duration = () => (TL ? TL.d.video_end : 0);
  /* the README play button (fsend's, in RetroX amber), centred at (x, y) in
   * film px so it can sit in the frame's empty space */
  window.__poster = function (x = 960, y = 540) {
    const b = el("div", "", document.getElementById("stage"));
    b.id = "poster-play";
    b.style.setProperty("--x", x + "px");
    b.style.setProperty("--y", y + "px");
  };
})();
