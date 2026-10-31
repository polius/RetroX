/* RetroX film — the scenes.
 *
 * Every scene is a function (cam, api) -> render(t) where t is seconds since the
 * scene's start. `cam` is the scene's camera: transform it to push, pan or
 * drift the whole shot. Moments come from the narration via api.on(line,
 * anchor) / api.segStart(line), so a frame is a pure function of t and the
 * visuals track the voice. Sound effects are registered up front with
 * api.cue(type, t) and mixed by sfx.py.
 *
 * What's on the screens is the real app: stills, scroll passes and touch
 * overlays captured read-only from a live RetroX (capture_app.py), and
 * Pokémon FireRed recorded frame by frame from the app's own player.
 */
(function () {
  const A = window.Toolkit;
  const { clamp, lerp, ramp, rnd, outQuint, outCubic, outExpo, inCubic, inOutCubic, inOutSine,
          outBack, spring, steps, reveal, hide, show, el, at, box, setText, words, kin,
          image, setSrc, seq, GAMEPLAY, pixText, pixArt, buildIn, PAL } = A;

  const AMBER = "#e5a00d", PEACH = "#edb068", SLATE = "#55698a", BERRY = "#e06a7a",
        LCD = "#d3dbe5", GREEN = "#34d399", CYAN = "#38bdf8";

  /* Square covers (object-fit: cover, rounded corners) drawn in perspective on
   * a 2D canvas. `at(u, v)` maps a point of the cover (0..side CSS px) to the
   * screen. Each cover is split into a grid of triangles, each drawn with its
   * own affine transform, so the perspective stays right across the cover; the
   * triangles go onto a scratch canvas opaque first (no seams), then the cover
   * is laid onto the wall at its opacity. */
  function wallTiles(cv, imgs, side, radius, grid = 5) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = 1920 * dpr; cv.height = 1080 * dpr;
    const ctx = cv.getContext("2d");
    const scratch = document.createElement("canvas");
    scratch.width = cv.width; scratch.height = cv.height;
    const sctx = scratch.getContext("2d");
    ctx.imageSmoothingQuality = sctx.imageSmoothingQuality = "high";
    const tex = {};
    const texture = (url) => {
      if (tex[url]) return tex[url];
      const img = imgs[url], n = Math.min(img.naturalWidth, img.naturalHeight) || 1;
      const c = document.createElement("canvas");
      c.width = c.height = n;
      const g = c.getContext("2d");
      g.beginPath(); g.roundRect(0, 0, n, n, radius * n / side); g.clip();
      g.drawImage(img, (img.naturalWidth - n) / 2, (img.naturalHeight - n) / 2, n, n, 0, 0, n, n);
      return (tex[url] = c);
    };
    // the affine map taking texture triangle s onto screen triangle d
    const affine = (s, d) => {
      const [[u0, v0], [u1, v1], [u2, v2]] = s, [[x0, y0], [x1, y1], [x2, y2]] = d;
      const du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0, det = du1 * dv2 - du2 * dv1;
      const a = ((x1 - x0) * dv2 - (x2 - x0) * dv1) / det, c = (du1 * (x2 - x0) - du2 * (x1 - x0)) / det;
      const b = ((y1 - y0) * dv2 - (y2 - y0) * dv1) / det, e = (du1 * (y2 - y0) - du2 * (y1 - y0)) / det;
      return [a, b, c, e, x0 - a * u0 - c * v0, y0 - b * u0 - e * v0];
    };
    return {
      clear() { ctx.clearRect(0, 0, cv.width, cv.height); },
      draw(url, at, alpha) {
        const t = texture(url), n = t.width;
        const pts = [];
        for (let j = 0; j <= grid; j++) for (let i = 0; i <= grid; i++) {
          const [x, y, z] = at(side * i / grid, side * j / grid);
          if (z > PERSP_LIMIT) return;                     // behind the eye: skip
          pts.push([x * dpr, y * dpr]);
        }
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2);
        x1 = Math.min(cv.width, Math.ceil(x1) + 2); y1 = Math.min(cv.height, Math.ceil(y1) + 2);
        if (x1 <= x0 || y1 <= y0) return;
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(x0, y0, x1 - x0, y1 - y0);
        const P = (i, j) => pts[j * (grid + 1) + i], T = (i, j) => [i * n / grid, j * n / grid];
        for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
          for (const tri of [[[i, j], [i + 1, j], [i, j + 1]], [[i + 1, j], [i + 1, j + 1], [i, j + 1]]]) {
            const d = tri.map(([a, b]) => P(a, b)), s = tri.map(([a, b]) => T(a, b));
            // grow the clip a pixel past the edges so neighbours overlap
            const mx = (d[0][0] + d[1][0] + d[2][0]) / 3, my = (d[0][1] + d[1][1] + d[2][1]) / 3;
            sctx.save();
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            sctx.beginPath();
            d.forEach(([x, y], q) => {
              const l = Math.hypot(x - mx, y - my) || 1;
              sctx[q ? "lineTo" : "moveTo"](x + (x - mx) / l, y + (y - my) / l);
            });
            sctx.closePath(); sctx.clip();
            sctx.setTransform(...affine(s, d));
            sctx.drawImage(t, 0, 0);
            sctx.restore();
          }
        }
        ctx.globalAlpha = alpha;
        ctx.drawImage(scratch, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        ctx.globalAlpha = 1;
      },
    };
  }
  const PERSP_LIMIT = 1300;

  /* ------------------------------------------------------------------ *
   *  pixel art
   * ------------------------------------------------------------------ */
  const ICON = {
    cursor: ["w.........", "ww........", "wkw.......", "wkkw......", "wkkkw.....", "wkkkkw....",
             "wkkkkkw...", "wkkkkkkw..", "wkkkkwwww.", "wkwkkw....", "ww.wkkw...", "w...wkw...", "....ww...."],
    gamepad: ["..ssssssssssss..", ".ssssssssssssss.", "sssswssssssssbss", "ssswwwsssssbssss",
              "sssswsssssssssss", "sssssssddsssssss", "sssssss..sssssss", ".sssss....sssss.", "..sss......sss.."],
    floppy: ["aaaaaaaaaa..", "aa.llllll.a.", "aa.llllll.aa", "aa.llllll.aa", "aaaaaaaaaaaa", "aaaaaaaaaaaa",
             "aawwwwwwwwaa", "aawwwwwwwwaa", "aawwddwwwwaa", "aawwddwwwwaa", "aawwwwwwwwaa", "aaaaaaaaaaaa"],
    phone: [".sssssss.", "sssssssss", "sllllllls", "sllllllls", "sllllllls", "sllwlllls", "slwwwlbls",
            "sllwlblls", "sllllllls", "sllllllls", "sllllllls", "sllllllls", "sssssssss", "sssswssss", ".sssssss."],
    server: ["ssssssssssssss", "sdddddddddddds", "sdgddddddwwwds", "sdddddddddddds", "ssssssssssssss",
             "..............", "ssssssssssssss", "sdddddddddddds", "sdgddddddwwwds", "sdddddddddddds",
             "ssssssssssssss"],
  };
  ICON.rewind = Array.from({ length: 9 }, (_, i) => {
    const w = 5 - Math.abs(i - 4);
    let row = "";
    for (let x = 0; x < 13; x++) {
      const a = x >= 5 - w && x <= 4, b = x >= 11 - w && x <= 10, bar = x === 12 && i > 0 && i < 8;
      row += a || b ? "a" : bar ? "w" : ".";
    }
    return row;
  });

  /* the logo, rebuilt as a 20x28 pixel sprite from its own geometry
     (frontend/images/emulator-logo-transparent.png, on a 16 px grid) */
  function logoCells() {
    const cells = [];
    const inRound = (x, y, x0, y0, x1, y1, r) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      const cx = clamp(x, x0 + r, x1 - r), cy = clamp(y, y0 + r, y1 - r);
      return Math.hypot(x - cx, y - cy) <= r;
    };
    for (let j = 0; j < 28; j++) for (let i = 0; i < 20; i++) {
      const x = 96 + i * 16 + 8, y = 32 + j * 16 + 8;
      if (!inRound(x, y, 96, 32, 416, 480, 30)) continue;
      let c = PEACH;
      if (x > 128 && x < 384 && y > 64 && y < 240) c = LCD;
      else if ((x > 160 && x < 192 && y > 296 && y < 376) || (x > 136 && x < 216 && y > 320 && y < 352)) c = SLATE;
      else if (Math.hypot(x - 360, y - 304) < 26 || Math.hypot(x - 304, y - 360) < 26) c = BERRY;
      else if (y > 432 && y < 448 && ((x > 222 && x < 250) || (x > 262 && x < 290))) c = SLATE;
      cells.push({ x: i, y: j, c });
    }
    return cells;
  }
  /* the logo sprite: squares that fly in from a scatter and lock into place */
  function logoSprite(parent, dot) {
    const cells = logoCells();
    const w = 20 * dot, h = 28 * dot;
    const s = A.svg("svg", { class: "pix", width: w, height: h, viewBox: `0 0 ${w} ${h}`, style: "overflow:visible" }, parent);
    const rects = cells.map((c, k) => {
      const r = A.svg("rect", { width: dot, height: dot, fill: c.c }, s);
      const ang = rnd(k * 3.7) * Math.PI * 2, dist = 500 + rnd(k * 1.3) * 700;
      r.from = [c.x * dot + Math.cos(ang) * dist, c.y * dot + Math.sin(ang) * dist * 0.6];
      r.to = [c.x * dot, c.y * dot];
      r.delay = (27 - c.y) / 27 * 0.55 + rnd(k * 9.1) * 0.25;
      return r;
    });
    return {
      node: s, w, h,
      set(t, t0, dur = 0.55) {
        rects.forEach((r) => {
          const p = outCubic(ramp(t, t0 + r.delay, t0 + r.delay + dur));
          const q = steps(p, 6);
          r.setAttribute("x", lerp(r.from[0], r.to[0], q).toFixed(1));
          r.setAttribute("y", lerp(r.from[1], r.to[1], q).toFixed(1));
          r.setAttribute("opacity", p > 0 ? 1 : 0);
        });
      },
    };
  }

  /* "RetroX", the app's wordmark: Retro in amber, X in white */
  function wordmark(parent, size) {
    const n = el("div", "word", parent);
    n.style.fontSize = size + "px";
    const letters = "RetroX".split("").map((c, i) => {
      const k = el("span", "kt", n);
      return el("span", i < 5 ? "r" : "x", k, c);
    });
    return { node: n, letters };
  }

  /* ------------------------------------------------------------------ *
   *  devices
   * ------------------------------------------------------------------ */
  function browser(parent, x, y, viewW, title) {
    const viewH = Math.round(viewW * 9 / 16);
    const n = el("div", "browser", parent);
    Object.assign(n.style, { left: x - viewW / 2 + "px", top: y - (viewH + 46) / 2 + "px", width: viewW + "px", height: viewH + 46 + "px" });
    const chrome = el("div", "chrome", n);
    el("div", "lights", chrome, "<i></i><i></i><i></i>");
    const tab = el("div", "tab", chrome, `<img src="/images/emulator-logo.png" alt=""><span></span>`);
    setText(tab.querySelector("span"), title);
    const view = el("div", "view", n);
    return { node: n, view, tab: tab.querySelector("span"), viewW, viewH };
  }

  function phone(parent) {
    const n = el("div", "phone", parent);
    Object.assign(n.style, { width: "421px", height: "880px", left: "-210.5px", top: "-440px" });
    const scr = el("div", "screen", n);
    el("div", "island", n);
    for (const [side, top, h] of [["left", 190, 60], ["left", 270, 90], ["left", 375, 90], ["right", 290, 130]]) {
      const b = el("div", "btn", n);
      Object.assign(b.style, { [side]: "-4px", top: top + "px", height: h + "px" });
    }
    const wrap = el("div", "abs", parent);   // positioned + rotated by the scene
    wrap.appendChild(n);
    return { wrap, node: n, screen: scr };
  }

  /* the phone's player: recorded gameplay under the app's own touch controls */
  function phonePlayer(screen, api, kind, folder) {
    const shot = api.data.shots[kind];
    const [vw, vh] = shot.viewport, [gx, gy, gw, gh] = shot.screen;
    const holder = el("div", "abs", screen);
    Object.assign(holder.style, { left: 0, top: 0, width: vw + "px", height: vh + "px", background: "#000" });
    const game = el("img", "game", holder);
    Object.assign(game.style, { left: gx + "px", top: gy + "px", width: gw + "px", height: gh + "px" });
    const overlay = image(holder, `/app/${kind}.png`, "shot");
    const play = seq(game, folder, GAMEPLAY[folder]);
    return { holder, game, play, overlay };
  }

  function camera(cam, t, keys, drift = 1) {
    let s = keys[0][1], x = keys[0][2], y = keys[0][3];
    for (let i = 1; i < keys.length; i++) {
      const [t1, s1, x1, y1, d = 0.9] = keys[i];
      const p = inOutCubic(ramp(t, t1, t1 + d));
      s = lerp(s, s1, p); x = lerp(x, x1, p); y = lerp(y, y1, p);
    }
    x += drift * 5 * Math.sin(t * 0.45); y += drift * 4 * Math.cos(t * 0.37);
    cam.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(5)})`;
  }

  function typeCues(api, t0, n, rate, gain = 0.5) {
    for (let i = 0; i < n; i++) api.cue("key", t0 + i * rate + (rnd(i * 3.1 + t0) - 0.5) * rate * 0.3, gain);
  }

  /* a big pixel stamp: lands with a bump and leaves in steps */
  function stamp(node, t, t0, t1) {
    if (t < t0 || t > t1 + 0.2) { node.style.visibility = "hidden"; return; }
    node.style.visibility = "visible";
    const p = ramp(t, t0, t0 + 0.18), q = ramp(t, t1, t1 + 0.2);
    const s = lerp(1.6, 1, steps(outCubic(p), 5)) * lerp(1, 0.6, q);
    node.style.transform = `scale(${s.toFixed(3)})`;
    node.style.opacity = (steps(p, 4) * (1 - steps(q, 4))).toFixed(3);
  }

  /* ------------------------------------------------------------------ *
   *  1. open — the screen powers on, the logo builds, "This is RetroX"
   * ------------------------------------------------------------------ */
  SCENES.open = (cam, api) => {
    const nameAt = api.on("open1", "name"), colAt = api.on("open2", "collection");
    const brAt = api.on("open2", "browser");
    const HIT = 2.45;

    // The cover wall: the real library, tilted into the distance. It is drawn
    // on a canvas with its own perspective projection (the same geometry as CSS
    // `perspective: 1400px; rotateX(52deg) rotateZ(-14deg)`), not with CSS 3D:
    // headless Chromium depth-sorts CSS 3D layers differently from one frame to
    // the next, and the near covers flashed in front of the shade and headline.
    const games = api.data.games;
    const covers = [];
    const COLS = 14, ROWS = 7, P = 250, SIDE = 230, PERSP = 1400;
    const stash = el("div", "", cam);
    stash.style.display = "none";
    const imgs = {};
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const url = `/app/${games[(r * COLS + c * 5) % games.length].cover}`;
      imgs[url] = imgs[url] || image(stash, url);
      covers.push({ url, x: (c - COLS / 2) * P, y: (r - ROWS / 2) * P, r, c, k: rnd(r * 13 + c * 7) });
    }
    const wallCv = el("canvas", "abs", cam);
    Object.assign(wallCv.style, { left: 0, top: 0, width: "1920px", height: "1080px" });
    const wall = wallTiles(wallCv, imgs, SIDE, 14);
    const RX = 52 * Math.PI / 180, RZ = -14 * Math.PI / 180;
    const cx = Math.cos(RX), sx = Math.sin(RX), cz = Math.cos(RZ), sz = Math.sin(RZ);
    // a point on the wall (wall-local px, z toward the viewer) -> screen px
    const project = (x, y, z, ty) => {
      y += ty;
      const x1 = x * cz - y * sz, y1 = x * sz + y * cz;
      const y2 = y1 * cx - z * sx, z2 = y1 * sx + z * cx;
      const w = PERSP / (PERSP - z2);
      return [960 + x1 * w, 540 + y2 * w, z2];
    };
    const shade = el("div", "abs", cam);
    Object.assign(shade.style, { inset: 0, background: "radial-gradient(ellipse 60% 55% at 50% 52%, rgba(7,9,12,0.92), rgba(7,9,12,0.55) 70%, rgba(7,9,12,0.3))" });

    const lock = el("div", "abs", cam);
    Object.assign(lock.style, { left: "960px", top: "540px", width: 0, height: 0 });
    const sprite = logoSprite(lock, 16);
    Object.assign(sprite.node.style, { position: "absolute", left: "-460px", top: -sprite.h / 2 + "px" });
    const smooth = image(lock, "/images/emulator-logo-transparent.png");
    // the transparent logo is 512 px with the handheld at 96..416 x 32..480
    Object.assign(smooth.style, { position: "absolute", width: 512 * 16 / 16 + "px", left: (-460 - 96) + "px", top: (-sprite.h / 2 - 32) + "px" });
    const flash = el("div", "abs", lock);
    Object.assign(flash.style, { left: "-470px", top: -sprite.h / 2 - 10 + "px", width: sprite.w + 20 + "px", height: sprite.h + 20 + "px", background: "#fff", borderRadius: "30px" });
    const wm = wordmark(lock, 230);
    Object.assign(wm.node.style, { position: "absolute", left: "-60px", top: "-150px" });

    const l1 = at(cam, 960, 610, "headline");
    const w1 = words(l1, "Your retro collection.");
    w1[1].classList.add("amb");
    const l2 = at(cam, 960, 745, "headline sm");
    const w2 = words(l2, "Right in your browser.");
    w2[3].classList.add("amb");

    // sound + light
    for (let i = 0; i < 9; i++) api.cue("build", 0.75 + i * 0.16, 0.45 + i * 0.04);
    api.cue("hit", HIT, 1);
    api.pulse(HIT, 1.2);
    api.cue("pop", nameAt - 0.35, 0.5);
    for (let i = 0; i < 6; i++) api.cue("pop", colAt - 0.1 + i * 0.09, 0.28);
    api.accent(colAt, AMBER);
    api.pulse(brAt - 0.1, 0.8, 960, 745);

    return (t) => {
      camera(cam, t, [[0, 1, 0, 0], [4.4, 1, 0, 0, 1.2]], 0.4);
      sprite.set(t, 0.65, 0.5);
      const sm = ramp(t, HIT, HIT + 0.25);
      sprite.node.style.opacity = (1 - sm).toFixed(3);
      smooth.style.opacity = sm.toFixed(3);
      flash.style.opacity = (0.85 * (1 - ramp(t, HIT, HIT + 0.35)) * (t >= HIT ? 1 : 0)).toFixed(3);
      wm.letters.forEach((s, i) => {
        const p = outQuint(ramp(t, HIT + 0.15 + i * 0.05, HIT + 0.65 + i * 0.05));
        s.style.transform = `translateY(${((1 - p) * 110).toFixed(1)}%)`;
      });
      // the lockup moves up and out of the way for the headline
      const up = inOutCubic(ramp(t, 4.45, 5.25));
      const bounce = 1 + 0.04 * Math.sin(Math.PI * ramp(t, HIT, HIT + 0.3));
      // the logo builds centred, then makes room for the name
      const side = inOutCubic(ramp(t, HIT + 0.05, HIT + 0.55));
      const lx = lerp(300, -80, side) * (1 - up);
      lock.style.transform = `translate(${lx.toFixed(1)}px, ${(-330 * up).toFixed(1)}px) scale(${(lerp(1, 0.42, up) * bounce).toFixed(4)})`;
      // the headline over the wall
      if (t > 4.6) {
        show(l1, true); show(l2, true);
        kin(w1, t, 4.75, 0.08);
        kin(w2, t, brAt - 0.75, 0.08);
      } else { hide(l1); hide(l2); }
      // the wall of covers: tilted, drifting, popping in from the centre
      const wp = ramp(t, colAt - 0.2, colAt + 0.9);
      const ty = -120 - (t - colAt) * 40;
      wall.clear();
      if (wp > 0) {
        const quads = [];
        for (const { url, x, y, r, c, k } of covers) {
          const d = Math.hypot(c - COLS / 2, (r - ROWS / 2) * 1.6) / 9;
          const p = steps(outCubic(ramp(t, colAt - 0.2 + d * 0.6 + k * 0.1, colAt + d * 0.6 + k * 0.1 + 0.15)), 4);
          if (p <= 0) continue;
          const z = (1 - p) * -300;
          const at = (u, v) => project(x + u, y + v, z, ty);
          quads.push({ url, alpha: p * 0.8, at, depth: at(SIDE / 2, SIDE / 2)[2] });
        }
        quads.sort((a, b) => a.depth - b.depth).forEach((q) => wall.draw(q.url, q.at, q.alpha));
      }
      shade.style.opacity = (0.4 + 0.6 * ramp(t, colAt - 0.2, colAt + 0.6)).toFixed(3);
    };
  };

  /* ------------------------------------------------------------------ *
   *  2. library — the real library, every system, search
   * ------------------------------------------------------------------ */
  SCENES.library = (cam, api) => {
    api.hud("STAGE 1 LIBRARY");
    const every = api.on("lib1", "every"), libAt = api.on("lib1", "library");
    const sys = ["gb", "n64", "psx", "any"].map((k) => api.on("lib2", k));
    const colAt = api.on("lib3", "collections"), covAt = api.on("lib3", "covers");
    const srchAt = api.on("lib3", "search"), keyAt = api.on("lib3", "keystroke");

    const win = browser(cam, 1040, 560, 1440, "Library · RetroX");
    const base = image(win.view, "/app/library.png", "shot");
    const scroll = el("img", "shot", win.view);
    const gba = image(win.view, "/app/library_gba.png", "shot");
    const col = image(win.view, "/app/collection.png", "shot");
    const search = [0, 1, 2, 3, 4].map((i) => image(win.view, `/app/search_${i}.png`, "shot"));

    // the system select: an arcade menu down the left
    const menu = el("div", "abs", cam);
    Object.assign(menu.style, { left: "70px", top: "330px", padding: "34px 36px 36px", borderRadius: "22px",
      background: "rgba(11,13,17,0.92)", border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 40px 90px -20px rgba(0,0,0,0.9)" });
    const head = el("div", "", menu); head.style.marginBottom = "26px";
    pixText(head, "SELECT SYSTEM", { dot: 4, color: "#a8acb6" });
    const names = ["GAME BOY", "NINTENDO 64", "PLAYSTATION", "+ ANY SYSTEM"];
    const rows = names.map((nm) => {
      const r = el("div", "", menu);
      Object.assign(r.style, { display: "flex", alignItems: "center", gap: "18px", height: "58px" });
      const cur = el("div", "", r); cur.style.width = "30px";
      const c = pixText(cur, ">", { dot: 5, color: AMBER });
      const lab = el("div", "", r);
      const p = pixText(lab, nm, { dot: 5, color: "#f4f5f8" });
      return { r, cur, p };
    });
    const ring = el("div", "abs", win.view);
    Object.assign(ring.style, { border: "4px solid " + AMBER, borderRadius: "12px", boxShadow: "0 0 30px " + AMBER });

    sys.forEach((s, i) => { api.cue(i === 3 ? "powerup" : "select", s, 0.8); api.pulse(s, i === 3 ? 1 : 0.5, 300, 420 + i * 58); });
    api.cue("swish", colAt - 0.05, 0.5);
    api.cue("swish", covAt - 0.05, 0.4);
    const KEYS = [srchAt + 0.2, srchAt + 0.42, srchAt + 0.64, srchAt + 0.86];
    api.cue("click", srchAt - 0.05, 0.6);
    KEYS.forEach((k) => api.cue("key", k, 0.7));
    api.cue("select", keyAt, 0.9);
    api.accent(sys[1], "#55698a");
    api.accent(sys[3], AMBER);

    return (t) => {
      // window enters tilted, settles; the camera then follows the story
      const enter = outQuint(ramp(t, 0, 0.8));
      win.node.style.transform = `perspective(1800px) translateY(${((1 - enter) * 260).toFixed(1)}px) rotateX(${((1 - enter) * 18).toFixed(2)}deg)`;
      camera(cam, t, [
        [0, 1, -80, 0],
        [sys[0] - 0.5, 0.92, 60, 0, 0.8],
        [colAt - 0.3, 1.0, -80, 0, 0.7],
        [covAt, 1.35, -420, -40, 0.9],
        [srchAt - 0.35, 1.25, -60, 240, 0.7],
      ], 0.6);

      // scroll pass through the real library
      const sp = inOutSine(ramp(t, every, libAt + 0.4));
      const k = Math.round(sp * 149);
      const scrolling = t >= every && t < sys[1];
      show(scroll, scrolling);
      if (scrolling) setSrc(scroll, `/app/scroll/${String(k).padStart(3, "0")}.png`);
      show(gba, t >= sys[1] && t < colAt);
      show(col, t >= colAt && t < srchAt);
      let si = -1;
      if (t >= srchAt) { si = 0; KEYS.forEach((kk, i) => { if (t >= kk + 0.05) si = i + 1; }); }
      search.forEach((s, i) => show(s, i === si));
      setText(win.tab, t >= sys[1] && t < colAt ? "Game Boy Advance · RetroX" : t >= colAt && t < srchAt ? "Pokémon · RetroX" : "Library · RetroX");

      // the system menu
      const mIn = ramp(t, sys[0] - 0.45, sys[0] - 0.05), mOut = ramp(t, colAt - 0.5, colAt - 0.15);
      menu.style.visibility = mIn > 0 && mOut < 1 ? "visible" : "hidden";
      menu.style.opacity = (steps(mIn, 4) * (1 - steps(mOut, 4))).toFixed(3);
      menu.style.transform = `translateX(${(-60 * (1 - outCubic(mIn))).toFixed(1)}px)`;
      let sel = -1; sys.forEach((s, i) => { if (t >= s) sel = i; });
      rows.forEach((r, i) => {
        r.cur.style.visibility = i === sel && Math.floor((t - sys[i]) * 6) % 2 === 0 || (i === sel && t - sys[i] > 0.4) ? "visible" : "hidden";
        r.p.node.style.opacity = i === sel ? 1 : i < sel ? 0.55 : 0.4;
        r.p.rects.forEach((q) => q.setAttribute("fill", i === sel ? AMBER : "#f4f5f8"));
        if (i === 3) r.r.style.transform = `scale(${(1 + 0.08 * Math.sin(Math.PI * ramp(t, sys[3], sys[3] + 0.3))).toFixed(3)})`;
      });

      // the search result lights up
      const rp = ramp(t, keyAt, keyAt + 0.25);
      if (t >= keyAt && t < keyAt + 1.2) {
        const s = win.viewW / 1920;
        Object.assign(ring.style, { left: 653 * s + "px", top: 207 * s + "px", width: 614 * s + "px", height: 52 * s + "px" });
        ring.style.visibility = "visible";
        ring.style.opacity = (steps(rp, 3) * (1 - ramp(t, keyAt + 0.9, keyAt + 1.2))).toFixed(3);
      } else ring.style.visibility = "hidden";
    };
  };

  /* ------------------------------------------------------------------ *
   *  3. play — press play, and the window becomes the game
   * ------------------------------------------------------------------ */
  SCENES.play = (cam, api) => {
    api.hud("STAGE 2 PLAY");
    const playAt = api.on("play1", "play"), inAt = api.on("play1", "in");
    const dl = api.on("play2", "downloads"), pl = api.on("play2", "plugins"), gm = api.on("play2", "game");

    const win = browser(cam, 960, 555, 1440, "Pokémon FireRed Version · RetroX");
    const page = image(win.view, "/app/game.png", "shot");
    const s = win.viewW / 1920;
    // Play button on the real game page (1920x1080 layout)
    const btn = box(win.view, 707 * s, 287 * s, 124 * s, 48 * s);
    Object.assign(btn.style, { borderRadius: "999px", boxShadow: `0 0 0 4px ${AMBER}, 0 0 40px ${AMBER}` });
    const cur = pixArt(cam, ICON.cursor, 5);
    Object.assign(cur.node.style, { position: "absolute", left: 0, top: 0, zIndex: 40 });

    // the game, full screen
    const stage = el("div", "abs", cam);
    Object.assign(stage.style, { left: 0, top: 0, width: "1920px", height: "1080px", background: "#000", overflow: "hidden" });
    const game = el("img", "game", stage);
    Object.assign(game.style, { left: "150px", top: 0, width: "1620px", height: "1080px" });
    const intro = seq(game, "intro", GAMEPLAY.intro), title = seq(game, "title", GAMEPLAY.title);
    const lines = el("div", "abs", stage);
    Object.assign(lines.style, { inset: 0, background: "repeating-linear-gradient(180deg, rgba(0,0,0,0.22) 0 2px, transparent 2px 6px)" });

    const band = el("div", "abs", cam);
    Object.assign(band.style, { left: 0, right: 0, top: "860px", height: "160px", background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.75) 40%, rgba(0,0,0,0.75))" });
    const stamps = [["NO DOWNLOADS", dl, pl - 0.12], ["NO PLUGINS", pl, gm - 0.12], ["JUST THE GAME", gm, api.dur]].map(([txt, a, b]) => {
      const n = at(cam, 960, 950, "");
      pixText(n, txt, { dot: 12, gap: 2, color: (c) => (txt.startsWith("NO") && c.x < 12 ? BERRY : txt.startsWith("JUST") ? AMBER : "#f4f5f8") });
      return { n, a, b };
    });

    api.cue("click", playAt, 1);
    api.cue("start", inAt - 0.05, 0.9);
    api.pulse(inAt, 1);
    stamps.forEach(({ a }) => api.cue("stamp", a, 0.9));
    api.cue("hit", gm, 0.6);
    api.accent(inAt, "#e06a7a");
    api.accent(gm, AMBER);

    return (t) => {
      const grow = inOutCubic(ramp(t, inAt - 0.05, inAt + 0.5));
      // the cursor glides to Play and clicks
      const cp = inOutCubic(ramp(t, 0, playAt - 0.05));
      const bx = 960 - win.viewW / 2 + 769 * s, by = 555 - (win.viewH + 46) / 2 + 46 + 311 * s;
      const cx = lerp(1500, bx, cp), cy = lerp(900, by, cp);
      const press = t >= playAt && t < playAt + 0.12 ? 0.85 : 1;
      cur.node.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px) scale(${press})`;
      cur.node.style.opacity = (1 - ramp(t, inAt - 0.1, inAt + 0.1)).toFixed(3);
      btn.style.opacity = (steps(ramp(t, playAt, playAt + 0.1), 2) * (1 - ramp(t, playAt + 0.4, playAt + 0.6))).toFixed(3);
      camera(cam, t, [[0, 1, 0, 0], [0.1, 1.12, 120, 60, playAt], [inAt - 0.05, 1, 0, 0, 0.5]], 0.3);

      // the window's view opens into the full-screen game
      const vx = lerp(960 - win.viewW / 2, 0, grow), vy = lerp(555 - (win.viewH + 46) / 2 + 46, 0, grow);
      const vw = lerp(win.viewW, 1920, grow), vh = lerp(win.viewH, 1080, grow);
      const on = t >= inAt - 0.05;
      stage.style.visibility = on ? "visible" : "hidden";
      Object.assign(stage.style, { left: vx.toFixed(1) + "px", top: vy.toFixed(1) + "px", width: vw.toFixed(1) + "px", height: vh.toFixed(1) + "px" });
      const gw = Math.min(vw, vh * 1.5), gh = gw / 1.5;
      Object.assign(game.style, { left: ((vw - gw) / 2).toFixed(1) + "px", top: ((vh - gh) / 2).toFixed(1) + "px", width: gw.toFixed(1) + "px", height: gh.toFixed(1) + "px" });
      win.node.style.opacity = (1 - ramp(t, inAt + 0.3, inAt + 0.5)).toFixed(3);
      if (on) {
        if (t < gm) intro(t - inAt + 4.2);   // join the intro as the battle starts
        else title(t - gm + 1.2);
      }
      band.style.opacity = ramp(t, dl - 0.3, dl).toFixed(3);
      stamps.forEach(({ n, a, b }) => stamp(n, t, a, b));
    };
  };

  /* ------------------------------------------------------------------ *
   *  4. mobile — the phone: library, touch controls, sideways
   * ------------------------------------------------------------------ */
  SCENES.mobile = (cam, api) => {
    api.hud("STAGE 3 ON THE GO");
    const whAt = api.on("mob1", "wherever"), phAt = api.on("mob2", "phone"), tcAt = api.on("mob2", "touch");
    const swAt = api.on("mob3", "sideways"), hhAt = api.on("mob3", "handheld");
    const ROT = swAt + 0.05;

    const ph = phone(cam);
    const lib = image(ph.screen, "/app/m_library.png", "shot");
    const scroll = el("img", "shot", ph.screen);
    const port = phonePlayer(ph.screen, api, "m_play_port", "naming");
    // landscape content lives in the phone's rotated frame
    const landWrap = el("div", "abs", ph.screen);
    Object.assign(landWrap.style, { left: "196.5px", top: "426px", width: 0, height: 0 });
    const landInner = el("div", "abs", landWrap);
    Object.assign(landInner.style, { left: "-426px", top: "-196.5px", width: "852px", height: "393px", transform: "rotate(90deg)" });
    const land = phonePlayer(landInner, api, "m_play_land", "town");

    const rings = [[72, 688, 124], [359, 686, 66], [288, 716, 66]].map(([x, y, r]) => {
      const n = box(ph.screen, x - r / 2, y - r / 2, r, r);
      Object.assign(n.style, { borderRadius: "50%", border: `4px solid ${AMBER}`, boxShadow: `0 0 26px ${AMBER}` });
      return n;
    });

    const h1 = at(cam, 560, 470, "headline");
    const hw1 = words(h1, "Wherever you go.");
    hw1[0].classList.add("amb");
    const h2 = at(cam, 560, 470, "headline sm");
    const hw2 = words(h2, "Touch controls, right on screen.");
    h2.style.whiteSpace = "normal"; h2.style.width = "820px";
    hw2[0].classList.add("amb");
    const h3 = at(cam, 960, 165, "headline sm");
    const hw3 = words(h3, "Turn it sideways. It's a handheld.");
    hw3[5].classList.add("amb");

    api.cue("swish", 0.1, 0.6);
    api.cue("blip", phAt, 0.7);
    [0, 1, 2].forEach((i) => api.cue("pop", tcAt + i * 0.12, 0.5));
    api.cue("whoosh", ROT, 0.9);
    api.cue("powerup", hhAt, 0.8);
    api.pulse(hhAt, 1);
    api.accent(phAt, BERRY);
    api.accent(hhAt, AMBER);

    return (t) => {
      const enter = outQuint(ramp(t, 0, 0.8));
      const rot = inOutCubic(ramp(t, ROT, ROT + 0.75));
      const px = lerp(lerp(1700, 1340, enter), 960, rot), py = lerp(560, 640, rot);
      const sc = lerp(1, 1.62, inOutCubic(ramp(t, ROT + 0.1, ROT + 0.95))) * lerp(1, 1.04, ramp(t, hhAt, hhAt + 0.2) * (1 - ramp(t, hhAt + 0.2, hhAt + 0.6)));
      ph.wrap.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${(-90 * rot + (1 - enter) * 12).toFixed(2)}deg) scale(${sc.toFixed(4)})`;
      camera(cam, t, [[0, 1, 0, 0]], 0.5);

      // screen content
      const scrolling = t >= 0.4 && t < phAt;
      show(lib, t < phAt);
      show(scroll, scrolling);
      if (scrolling) setSrc(scroll, `/app/m_scroll/${String(Math.round(inOutSine(ramp(t, 0.6, phAt - 0.2)) * 119)).padStart(3, "0")}.png`);
      const showPort = t >= phAt && t < ROT + 0.35;
      show(port.holder, showPort);
      if (showPort) port.play((t - phAt) * 2.2 + 15.5);  // the typing, at 2.2x: R-E-T-R-O-X
      const showLand = t >= ROT + 0.35;
      show(land.holder, showLand);
      if (showLand) land.play(t - ROT + 9.0);
      rings.forEach((r, i) => {
        const p = ramp(t, tcAt + i * 0.12, tcAt + i * 0.12 + 0.3), q = ramp(t, swAt - 0.6, swAt - 0.3);
        r.style.visibility = p > 0 && q < 1 ? "visible" : "hidden";
        r.style.opacity = (steps(p, 3) * (1 - q) * (0.6 + 0.4 * Math.sin((t - tcAt) * 8))).toFixed(3);
      });

      // headlines
      show(h1, t > 0.3 && t < phAt);
      kin(hw1, t, 0.45, 0.08, 0.5, phAt - 0.45);
      show(h2, t > phAt - 0.2 && t < swAt);
      kin(hw2, t, phAt + 0.05, 0.07, 0.5, swAt - 0.5);
      show(h3, t > swAt - 0.3);
      kin(hw3.slice(0, 3), t, swAt - 0.15, 0.08);
      kin(hw3.slice(3), t, hhAt - 0.35, 0.08);
    };
  };

  /* ------------------------------------------------------------------ *
   *  5. sync — laptop to server to phone, right where you left off
   * ------------------------------------------------------------------ */
  SCENES.sync = (cam, api) => {
    api.hud("STAGE 4 SYNC");
    const svAt = api.on("sync1", "saves"), syAt = api.on("sync1", "sync"), secAt = api.on("sync1", "seconds");
    const lapAt = api.on("sync2", "laptop"), phAt = api.on("sync2", "phone"), leftAt = api.on("sync2", "left");

    const win = browser(cam, 500, 640, 800, "Pokémon FireRed Version · RetroX");
    win.view.style.background = "#000";
    const lg = el("img", "game", win.view);
    const gw = win.viewH * 1.5;
    Object.assign(lg.style, { left: (win.viewW - gw) / 2 + "px", top: 0, width: gw + "px", height: win.viewH + "px" });
    const lplay = seq(lg, "town", GAMEPLAY.town);
    const pill = at(win.view, win.viewW - 110, 40, "pill", `<span class="dot"></span><span>Synced</span>`);
    pill.style.fontSize = "17px"; pill.style.padding = "9px 15px";

    const ph = phone(cam);
    const land = el("div", "abs", ph.screen);
    Object.assign(land.style, { left: "196.5px", top: "426px", width: 0, height: 0 });
    const li = el("div", "abs", land);
    Object.assign(li.style, { left: "-426px", top: "-196.5px", width: "852px", height: "393px", transform: "rotate(90deg)" });
    const pp = phonePlayer(li, api, "m_play_land", "town");
    const off = el("div", "abs", ph.screen);
    Object.assign(off.style, { inset: 0, background: "#000" });

    const srv = at(cam, 960, 215, "server");
    pixArt(srv, ICON.server, 9);
    const srvLab = at(cam, 960, 350, "");
    pixText(srvLab, "YOUR SERVER", { dot: 4, color: "#a8acb6" });

    const packets = [];
    const flight = (t0, from, to) => { packets.push({ t0, from, to }); api.cue("jump", t0, 0.55); api.cue("coin", t0 + 0.55, 0.45); };
    flight(svAt, [560, 420], [960, 215]);
    flight(secAt, [560, 420], [960, 215]);
    flight(secAt + 0.75, [560, 420], [960, 215]);
    flight(phAt - 0.35, [960, 215], [1430, 500]);
    const sprites = packets.map(() => { const n = el("div", "abs", cam); pixArt(n, ICON.floppy, 5); return n; });

    const cont = at(cam, 1430, 880, "");
    pixText(cont, "> CONTINUE", { dot: 7, color: (c) => (c.x < 6 ? AMBER : "#f4f5f8") });
    const h1 = at(cam, 960, 990, "headline xs");
    const hw1 = words(h1, "Saves sync by themselves.");
    hw1[0].classList.add("amb");
    const h2 = at(cam, 960, 990, "headline xs");
    const hw2 = words(h2, "Pick up right where you left off.");
    hw2[5].classList.add("amb"); hw2[6].classList.add("amb");

    api.cue("blip", syAt, 0.6);
    api.cue("select", leftAt, 0.9);
    api.pulse(phAt + 0.2, 0.9, 1430, 650);
    api.accent(syAt, "#34d399");
    api.accent(leftAt, AMBER);

    // the laptop plays, then stops; the phone continues from the same frame
    const STOP = phAt - 0.5, BASE = 2.0;
    return (t) => {
      camera(cam, t, [[0, 0.96, 0, 10], [lapAt, 1, 0, 0, 1.0]], 0.4);
      ph.wrap.style.transform = `translate(1430px, 650px) rotate(-90deg) scale(0.9)`;
      const lt = Math.min(t, STOP);
      lplay(BASE + lt);
      pp.play(BASE + STOP + Math.max(0, t - phAt - 0.2));
      off.style.opacity = (1 - steps(ramp(t, phAt + 0.05, phAt + 0.35), 4)).toFixed(3);
      win.view.style.filter = t > STOP ? `brightness(${lerp(1, 0.45, ramp(t, STOP, STOP + 0.4)).toFixed(3)})` : "none";
      reveal(pill, ramp(t, syAt, syAt + 0.3), { dy: -10, scale: 0.9 });
      packets.forEach(({ t0, from, to }, i) => {
        const p = ramp(t, t0, t0 + 0.55), n = sprites[i];
        n.style.visibility = p > 0 && p < 1 ? "visible" : "hidden";
        const q = steps(inOutSine(p), 14);
        const x = lerp(from[0], to[0], q) - 30, y = lerp(from[1], to[1], q) - 30 - Math.sin(Math.PI * q) * 140;
        n.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      });
      reveal(cont, ramp(t, leftAt, leftAt + 0.25), { dy: 0, scale: 1.4, ease: (p) => steps(p, 4) });
      if (t > leftAt) cont.style.opacity = (Math.floor((t - leftAt) * 3) % 2 === 0 ? 1 : 0.55).toString();
      show(h1, t > 0.3 && t < 3.9);
      kin(hw1, t, 0.5, 0.07, 0.5, 3.4);
      show(h2, t > 3.8);
      kin(hw2, t, 4.0, 0.07);
    };
  };

  /* ------------------------------------------------------------------ *
   *  6. features — power-ups
   * ------------------------------------------------------------------ */
  SCENES.features = (cam, api) => {
    api.hud("BONUS STAGE");
    const keys = ["gamepads", "states", "rewind", "controller"].map((k) => api.on("feat1", k));
    const defs = [["gamepad", "GAMEPADS", 11], ["floppy", "SAVE STATES", 13], ["rewind", "REWIND", 13], ["phone", "PHONE AS PAD", 10]];
    const cards = defs.map(([ic, label, dot], i) => {
      const c = at(cam, 330 + i * 420, 540, "card");
      const g = el("div", "glowc", c);
      g.style.background = `radial-gradient(closest-side, ${[AMBER, BERRY, CYAN, GREEN][i]}33, transparent)`;
      const art = pixArt(c, ICON[ic], dot);
      art.node.style.position = "relative";
      const lab = el("div", "", c); lab.style.position = "relative";
      pixText(lab, label, { dot: 5, color: "#f4f5f8" });
      return { c, art };
    });
    keys.forEach((k, i) => { api.cue("powerup", k, 0.7); api.pulse(k, 0.8, 330 + i * 420, 540); });
    api.accent(keys[1], BERRY); api.accent(keys[2], CYAN); api.accent(keys[3], GREEN);
    return (t) => {
      camera(cam, t, [[0, 1.04, 0, 0], [4, 1, 0, 0, 4]], 0.4);
      cards.forEach(({ c, art }, i) => {
        const p = ramp(t, keys[i] - 0.05, keys[i] + 0.35);
        c.style.visibility = p > 0 ? "visible" : "hidden";
        const s = p < 1 ? lerp(0.3, 1, outBack(p, 2.2)) : 1;
        const hop = Math.max(0, Math.sin(Math.PI * ramp(t, keys[i], keys[i] + 0.4))) * 50;
        c.style.transform = `translateY(${(-hop).toFixed(1)}px) scale(${s.toFixed(3)})`;
        c.style.opacity = steps(clamp(p * 2), 4).toFixed(3);
        buildIn(art.rects, t, keys[i] - 0.05, 0.3);
      });
    };
  };

  /* ------------------------------------------------------------------ *
   *  7. self-host — free, open source, one command
   * ------------------------------------------------------------------ */
  SCENES.selfhost = (cam, api) => {
    api.hud("STAGE 5 SELF-HOST");
    const fr = api.on("self1", "free"), op = api.on("self1", "open"), ho = api.on("self1", "host");
    const dk = api.on("self2", "docker"), pl = api.on("self2", "running");

    const h = at(cam, 960, 250, "headline");
    const hw = words(h, "Free. Open source. Yours.");
    hw[0].classList.add("amb"); hw[3].classList.add("amb");

    const term = el("div", "term", cam);
    Object.assign(term.style, { left: "260px", top: "430px", width: "1400px", height: "400px" });
    el("div", "bar", term, `<div class="lights"><i></i><i></i><i></i></div>`);
    const body = el("div", "body", term);
    const CMD = "docker run -d -p 8080:8080 -v ./data:/data poliuscorp/retrox";
    const RATE = 0.017, T0 = dk - 0.2;
    typeCues(api, T0, CMD.length, RATE * 2, 0.35);
    api.cue("enter", T0 + CMD.length * RATE + 0.1, 0.8);
    api.cue("powerup", pl, 0.8);
    api.cue("pop", fr, 0.5); api.cue("pop", op, 0.5); api.cue("pop", ho, 0.6);
    api.pulse(pl, 1, 960, 700);
    const ready = at(cam, 1290, 760, "");
    pixText(ready, "READY!", { dot: 10, gap: 2, color: GREEN });

    return (t) => {
      camera(cam, t, [[0, 1, 0, 0], [dk - 0.5, 1.04, 0, -30, 1.2]], 0.4);
      show(h, t > 0.6);
      kin(hw.slice(0, 1), t, fr - 0.2, 0.08);
      kin(hw.slice(1, 3), t, op - 0.2, 0.08);
      kin(hw.slice(3), t, ho - 0.25, 0.08);
      reveal(term, ramp(t, dk - 0.9, dk - 0.4), { dy: 60, scale: 0.96 });
      const n = clamp(Math.floor((t - T0) / RATE), 0, CMD.length);
      const done = t > T0 + CMD.length * RATE + 0.15;
      const caret = Math.floor(t * 2.5) % 2 === 0 || !done ? '<span class="caret"></span>' : "";
      let html = `<span class="p">$</span> ${CMD.slice(0, t > T0 ? n : 0)}${done ? "" : caret}`;
      if (done) html += `\n<span class="ok">✓</span> RetroX is running on port 8080\n<span class="p">$</span> ${caret}`;
      setText(body, ""); body.innerHTML = html;
      reveal(ready, ramp(t, pl, pl + 0.2), { dy: 0, scale: 1.8, ease: (p) => steps(p, 4) });
    };
  };

  /* ------------------------------------------------------------------ *
   *  8. outro — the logo plays the game. Press start.
   * ------------------------------------------------------------------ */
  SCENES.outro = (cam, api) => {
    const stAt = api.on("outro2", "start"), nameAt = api.segStart("outro1");
    const LOGO = 440, k = LOGO / 512;
    const lock = el("div", "abs", cam);
    Object.assign(lock.style, { left: "960px", top: "420px", width: 0, height: 0 });
    const logo = image(lock, "/images/emulator-logo-transparent.png");
    Object.assign(logo.style, { position: "absolute", width: LOGO + "px", height: LOGO + "px", left: -LOGO / 2 + "px", top: -LOGO / 2 + "px" });
    // the logo's own LCD plays FireRed's title screen
    const lcd = el("img", "game", lock);
    Object.assign(lcd.style, { left: (-LOGO / 2 + 128 * k) + "px", top: (-LOGO / 2 + 64 * k) + "px", width: 256 * k + "px", height: 176 * k + "px", objectFit: "cover", borderRadius: "2px" });
    const play = seq(lcd, "title", GAMEPLAY.title);
    const wm = wordmark(cam, 150);
    const wmw = at(cam, 960, 760, "");
    wmw.appendChild(wm.node);
    const tag = at(cam, 960, 860, "sub", "Self-hosted retro gaming, right in your browser.");
    // the closing line, in the console's own type: INSTALL IT. START PLAYING.
    const instAt = api.on("outro2", "install");
    const close = at(cam, 960, 975, "");
    Object.assign(close.style, { display: "flex", gap: "48px", alignItems: "center" });
    const inst = el("div", "", close), go = el("div", "", close);
    pixText(inst, "INSTALL IT.", { dot: 7, color: AMBER });
    pixText(go, "> START PLAYING", { dot: 7, color: (c) => (c.x < 6 ? AMBER : "#f4f5f8") });
    api.cue("hit", nameAt - 0.05, 0.9);
    api.pulse(nameAt, 1.2, 960, 420);
    api.cue("select", instAt, 0.8);
    api.cue("start", stAt, 1);
    api.pulse(stAt, 1, 1150, 975);
    return (t) => {
      camera(cam, t, [[0, 1.06, 0, 0], [0, 1, 0, 0, 3]], 0.3);
      const lp = ramp(t, 0, 0.5);
      lock.style.transform = `scale(${lerp(0.6, 1, outBack(lp, 1.8)).toFixed(4)})`;
      lock.style.opacity = steps(lp, 5).toFixed(3);
      play(t + 2.0);
      wm.letters.forEach((s, i) => {
        const p = outQuint(ramp(t, nameAt - 0.25 + i * 0.05, nameAt + 0.25 + i * 0.05));
        s.style.transform = `translateY(${((1 - p) * 110).toFixed(1)}%)`;
      });
      reveal(tag, ramp(t, nameAt + 0.5, nameAt + 1.1), { dy: 16 });
      reveal(inst, ramp(t, instAt - 0.05, instAt + 0.15), { dy: 0, scale: 1.4, ease: (p) => steps(p, 4) });
      reveal(go, ramp(t, stAt - 0.05, stAt + 0.15), { dy: 0, scale: 1.4, ease: (p) => steps(p, 4) });
      if (t > stAt + 0.6) go.style.opacity = (Math.floor((t - stAt) * 2.2) % 2 === 0 ? 1 : 0.35).toString();
    };
  };
})();
