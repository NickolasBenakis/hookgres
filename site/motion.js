// Ambient motion for the landing page: the hero's dot field, the floating code
// window, the cursor spotlight on cards and the packets in the flow sketch.
// Everything runs only while it is on screen, and none of it runs for people
// who ask for reduced motion (they get the static drawing).
{
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const root = document.documentElement;

  // One pointer position, shared. Smoothed copies chase it every frame.
  const pointer = { x: -9999, y: -9999, active: false };
  addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse") return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.active = true;
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => {
    pointer.active = false;
  });

  // Runs `tick` every frame while `el` is on screen and the tab is visible.
  const whileVisible = (el, tick, margin = "100px") => {
    let onScreen = false;
    let frame = 0;
    const loop = (now) => {
      tick(now);
      frame = requestAnimationFrame(loop);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      if (onScreen && !document.hidden) frame = requestAnimationFrame(loop);
    };
    new IntersectionObserver(
      (entries) => {
        onScreen = entries.at(-1).isIntersecting;
        sync();
      },
      { rootMargin: margin },
    ).observe(el);
    document.addEventListener("visibilitychange", sync);
  };

  const dark = () => root.dataset.theme === "dark";
  // Canvas can't read the oklch tokens portably, so the field keeps its own sRGB pair.
  const palette = () =>
    dark()
      ? { dot: [236, 238, 245], accent: [118, 162, 245], base: 0.15 }
      : { dot: [38, 44, 70], accent: [36, 92, 214], base: 0.2 };

  // Hero field
  const hero = document.querySelector(".hero");
  const canvas = document.querySelector(".hero-field");
  const copyEl = document.querySelector(".hero-copy");
  const stageEl = document.querySelector(".hero-stage");
  const capsEl = document.querySelector(".hero .caps");
  if (hero && canvas && copyEl && stageEl && capsEl) {
    const ctx = canvas.getContext("2d");
    const GAP = 22;
    // Touch screens have no cursor to light the field, so they get the still
    // grid instead of a full-time animation that costs battery.
    const still = reduce || !finePointer;
    let w = 0;
    let h = 0;
    let dots = [];
    let colors = palette();
    const lens = { x: -9999, y: -9999, strength: 0 };
    const streaks = [];
    let lastSpawn = 0;

    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      const ox = ((w % GAP) + GAP) / 2;
      for (let y = GAP / 2; y < h; y += GAP) {
        for (let x = ox; x < w; x += GAP)
          dots.push({ x, y, row: Math.round(y / GAP) });
      }
      if (still) draw();
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const [dr, dg, db] = colors.dot;
      const [ar, ag, ab] = colors.accent;
      const R = 170;
      for (const d of dots) {
        let x = d.x;
        let y = d.y;
        let glow = 0;
        if (lens.strength > 0.01) {
          const dx = d.x - lens.x;
          const dy = d.y - lens.y;
          const dist = Math.hypot(dx, dy);
          if (dist < R) {
            const f = (1 - dist / R) ** 2 * lens.strength;
            const push = f * 7;
            x += (dx / (dist || 1)) * push;
            y += (dy / (dist || 1)) * push;
            glow = f;
          }
        }
        for (const s of streaks) {
          if (s.row !== d.row) continue;
          const behind = s.x - d.x;
          if (behind > 0 && behind < s.len && d.x > s.start)
            glow = Math.max(glow, (1 - behind / s.len) * s.alpha);
        }
        const size = 1.3 + glow * 1.4;
        ctx.fillStyle =
          glow > 0.02
            ? `rgba(${ar},${ag},${ab},${colors.base + glow * 0.75})`
            : `rgba(${dr},${dg},${db},${colors.base})`;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
      // A webhook in flight: a short comet along one row of the grid.
      for (const s of streaks) {
        const y = s.row * GAP - GAP / 2;
        const tail = Math.max(s.start, s.x - s.len);
        const grad = ctx.createLinearGradient(s.x - s.len, y, s.x, y);
        grad.addColorStop(0, `rgba(${ar},${ag},${ab},0)`);
        grad.addColorStop(1, `rgba(${ar},${ag},${ab},${0.55 * s.alpha})`);
        ctx.fillStyle = grad;
        ctx.fillRect(tail, y - 0.75, s.x - tail, 1.5);
        ctx.fillStyle = `rgba(${ar},${ag},${ab},${0.9 * s.alpha})`;
        ctx.beginPath();
        ctx.arc(s.x, y, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    let last = 0;
    const tick = (now) => {
      const dt = Math.min(48, now - (last || now)) / 1000;
      last = now;
      const rect = canvas.getBoundingClientRect();
      const inside =
        pointer.active && pointer.y > rect.top && pointer.y < rect.bottom;
      const tx = pointer.x - rect.left;
      const ty = pointer.y - rect.top;
      if (lens.strength < 0.01 && inside) {
        lens.x = tx;
        lens.y = ty;
      }
      lens.x += (tx - lens.x) * 0.14;
      lens.y += (ty - lens.y) * 0.14;
      lens.strength += ((inside ? 1 : 0) - lens.strength) * 0.08;

      if (now - lastSpawn > 700 + Math.random() * 900 && streaks.length < 4) {
        lastSpawn = now;
        // Streaks stay out of the text: right of the copy when the hero has two
        // columns, below it when they stack.
        const copy = copyEl.getBoundingClientRect();
        const sideBySide = copy.right < stageEl.getBoundingClientRect().left;
        const minX = sideBySide ? copy.right - rect.left + 24 : 0;
        const minRow = sideBySide
          ? 1
          : Math.ceil((copy.bottom - rect.top) / GAP) + 1;
        // ...and above the feature list under the hero.
        const rows = Math.min(
          Math.floor(h / GAP),
          Math.floor((capsEl.getBoundingClientRect().top - rect.top) / GAP),
        );
        const start = minX + Math.random() * Math.max(0, (w - minX) * 0.15);
        if (rows > minRow)
          streaks.push({
            row:
              minRow + Math.floor(Math.random() * Math.max(1, rows - minRow)),
            start,
            x: start,
            len: 90 + Math.random() * 70,
            speed: 260 + Math.random() * 180,
            alpha: 0,
          });
      }
      for (let i = streaks.length - 1; i >= 0; i--) {
        const s = streaks[i];
        s.x += s.speed * dt;
        s.alpha = Math.min(1, (s.x - s.start) / 80, (w - s.x) / (w * 0.2));
        if (s.x - s.len > w) streaks.splice(i, 1);
      }
      draw();
    };

    new ResizeObserver(resize).observe(canvas);
    new MutationObserver(() => {
      colors = palette();
      if (still) draw();
    }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    if (!still) whileVisible(hero, tick, "0px");
  }

  // Floating code window: leans toward the cursor, its shadow falls away from it.
  const stage = document.querySelector(".hero-stage");
  if (stage && finePointer && !reduce) {
    const card = stage.querySelector(".hero-code");
    const shadow = stage.querySelector(".hero-shadow");
    const cur = { rx: 0, ry: 0, gx: 0, gy: 0 };
    whileVisible(stage, () => {
      const rect = stage.getBoundingClientRect();
      // -1..1 across a zone a bit larger than the card, 0 when the pointer is away.
      const nx = pointer.active
        ? Math.max(
            -1,
            Math.min(
              1,
              (pointer.x - (rect.left + rect.width / 2)) / (rect.width * 0.9),
            ),
          )
        : 0;
      const ny = pointer.active
        ? Math.max(
            -1,
            Math.min(
              1,
              (pointer.y - (rect.top + rect.height / 2)) / (rect.height * 0.9),
            ),
          )
        : 0;
      const target = {
        rx: -ny * 2.4,
        ry: nx * 3.2,
        gx: -nx * 16,
        gy: -ny * 14,
      };
      let moving = false;
      for (const k in cur) {
        cur[k] += (target[k] - cur[k]) * 0.08;
        if (Math.abs(target[k] - cur[k]) > 0.01) moving = true;
      }
      if (!moving) return;
      card.style.setProperty("--rx", `${cur.rx.toFixed(3)}deg`);
      card.style.setProperty("--ry", `${cur.ry.toFixed(3)}deg`);
      shadow.style.setProperty("--gx", `${cur.gx.toFixed(2)}px`);
      shadow.style.setProperty("--gy", `${cur.gy.toFixed(2)}px`);
    });
  }

  // Spotlight: each visible card learns where the pointer is, relative to itself.
  if (finePointer && !reduce) {
    const visible = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else {
          visible.delete(entry.target);
          delete entry.target.dataset.lit;
        }
      }
    });
    for (const el of document.querySelectorAll("[data-spot]")) io.observe(el);
    let queued = false;
    const update = () => {
      queued = false;
      for (const el of visible) {
        const r = el.getBoundingClientRect();
        const x = pointer.x - r.left;
        const y = pointer.y - r.top;
        const near =
          pointer.active &&
          x > -120 &&
          y > -120 &&
          x < r.width + 120 &&
          y < r.height + 120;
        if (near) {
          el.style.setProperty("--mx", `${x}px`);
          el.style.setProperty("--my", `${y}px`);
        }
        el.toggleAttribute("data-lit", near);
      }
    };
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    };
    addEventListener("pointermove", queue, { passive: true });
    addEventListener("scroll", queue, { passive: true });
    document.addEventListener("pointerleave", queue);
  }

  // Flow sketch: packets run the path of one commit, with a beat of rest between runs.
  const sketch = document.querySelector(".flow-sketch");
  if (sketch) {
    const svg = sketch.querySelector("svg");
    const layer = svg.querySelector(".sk-packets");
    const NS = "http://www.w3.org/2000/svg";
    const flashes = Object.fromEntries(
      [...svg.querySelectorAll("[data-flash]")].map((el) => [
        el.dataset.flash,
        el,
      ]),
    );
    const path = (id) => svg.querySelector(`#sk-${id}`);
    const tone = {
      accent: "var(--accent)",
      ok: "var(--ok)",
      warn: "var(--warn)",
      bad: "var(--bad)",
    };
    // [path, start s, duration s, colour, node to light on arrival]
    const CYCLE = 6.4;
    const plan = [
      ["a1", 0, 0.6, "accent", "row1"],
      ["a2", 0, 0.6, "accent", "row2"],
      ["m1", 1.0, 0.6, "accent", "w1"],
      ["m2", 1.08, 0.6, "accent", "w2"],
      ["m3", 1.16, 0.6, "accent", "w3"],
      ["e1", 1.75, 0.45, "ok", "e1"],
      ["e2", 1.83, 0.45, "warn", "e2"],
      ["e3", 1.91, 0.45, "bad", "e3"],
      ["r3", 2.6, 1.6, "bad", "row2"],
    ].map(([id, start, dur, color, flash]) => {
      const el = path(id);
      const len = el.getTotalLength();
      const streak = document.createElementNS(NS, "path");
      streak.setAttribute("d", el.getAttribute("d"));
      streak.setAttribute("class", "sk-streak");
      streak.style.stroke = tone[color];
      const halo = document.createElementNS(NS, "circle");
      halo.setAttribute("r", "8");
      halo.setAttribute("class", "sk-head-halo");
      halo.style.fill = tone[color];
      const headDot = document.createElementNS(NS, "circle");
      headDot.setAttribute("r", "3.5");
      headDot.style.fill = tone[color];
      const group = document.createElementNS(NS, "g");
      group.style.opacity = "0";
      group.setAttribute("data-step", el.dataset.step);
      group.append(streak, halo, headDot);
      layer.append(group);
      return {
        el,
        len,
        start,
        dur,
        flash,
        streak,
        halo,
        headDot,
        group,
        tail: Math.min(46, len * 0.45),
      };
    });
    // Arrivals per node, so a node lights after each packet reaches it.
    const arrivals = {};
    for (const p of plan) {
      arrivals[p.flash] ??= [];
      arrivals[p.flash].push(p.start + p.dur);
    }
    arrivals.commit = [0.72];

    // Steps under the drawing. Untouched, the lit step follows the packets and its bar
    // fills for the length of that phase. Hover, focus or press a step to hold the
    // drawing on it; pressing pins it until pressed again.
    const steps = [...sketch.querySelectorAll(".step")];
    const phases = [
      [0, 0.72],
      [0.72, 1.0],
      [1.0, 1.75],
      [1.75, CYCLE],
    ];
    let pinned = 0;
    let hoverStep = 0;
    const focusOn = (n) => {
      if (n) svg.dataset.focus = String(n);
      else delete svg.dataset.focus;
    };
    const syncFocus = () => focusOn(hoverStep || pinned);
    for (const [i, button] of steps.entries()) {
      const n = i + 1;
      button.addEventListener("pointerenter", (event) => {
        if (event.pointerType !== "mouse") return;
        hoverStep = n;
        syncFocus();
      });
      button.addEventListener("pointerleave", () => {
        hoverStep = 0;
        syncFocus();
      });
      // Keyboard focus holds the step; a tap's focus doesn't, so unpinning works on touch.
      button.addEventListener("focus", () => {
        if (!button.matches(":focus-visible")) return;
        hoverStep = n;
        syncFocus();
      });
      button.addEventListener("blur", () => {
        hoverStep = 0;
        syncFocus();
      });
      button.addEventListener("click", () => {
        pinned = pinned === n ? 0 : n;
        for (const [j, b] of steps.entries())
          b.setAttribute("aria-pressed", String(pinned === j + 1));
        syncFocus();
        // On narrow screens the drawing scrolls; bring the pressed step's part into view.
        const scroller = sketch.querySelector(".sketch-scroll");
        if (pinned && scroller.scrollWidth > scroller.clientWidth) {
          const ratio = scroller.scrollWidth / 1200;
          const left = [24, 300, 740, 960][pinned - 1] * ratio - 16;
          scroller.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
        }
      });
    }
    let shown = 0;
    const followPackets = (t) => {
      const held = hoverStep || pinned;
      const n = held ? 0 : phases.findIndex(([a, b]) => t >= a && t < b) + 1;
      if (n !== shown) {
        for (const [i, b] of steps.entries())
          b.toggleAttribute("data-active", i + 1 === n);
        shown = n;
      }
      if (n) {
        const [a, b] = phases[n - 1];
        steps[n - 1].style.setProperty("--p", ((t - a) / (b - a)).toFixed(3));
      }
    };

    const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
    let t0 = 0;
    const frame = (now) => {
      if (!t0) t0 = now;
      const t = ((now - t0) / 1000) % CYCLE;
      for (const p of plan) {
        const raw = (t - p.start) / p.dur;
        if (raw < 0 || raw > 1) {
          p.group.style.opacity = "0";
          continue;
        }
        const at = ease(raw) * p.len;
        const pt = p.el.getPointAtLength(at);
        p.group.style.opacity = String(Math.min(1, raw * 6, (1 - raw) * 6));
        p.streak.style.strokeDasharray = `${p.tail} ${p.len + p.tail}`;
        p.streak.style.strokeDashoffset = String(p.tail - at);
        p.halo.setAttribute("cx", pt.x);
        p.halo.setAttribute("cy", pt.y);
        p.headDot.setAttribute("cx", pt.x);
        p.headDot.setAttribute("cy", pt.y);
      }
      for (const [node, times] of Object.entries(arrivals)) {
        let lit = 0;
        for (const end of times) {
          const since = t - end;
          if (since >= 0 && since < 0.9) lit = Math.max(lit, 1 - since / 0.9);
        }
        flashes[node].style.opacity = (lit ** 1.5).toFixed(3);
      }
      followPackets(t);
    };

    if (reduce) {
      // Static: the whole drawing, one moment of the flow lit.
      for (const node of ["row1", "row2", "e1"])
        flashes[node].style.opacity = "0.6";
    } else {
      whileVisible(sketch, frame, "0px");
    }
  }

  // Live delivery log: a new delivery arrives at the top every few seconds, its
  // attempts tick in on the compressed schedule, and older rows slide down and out.
  // Hovering the window or pressing Pause freezes it where it is.
  const logWindow = document.querySelector(".log-window");
  if (logWindow && !reduce) {
    const list = logWindow.querySelector(".log-rows");
    const toggle = logWindow.querySelector(".live-toggle");
    const idLabel = logWindow.querySelector(".log-id");
    // Five distinct endpoints in a fixed order, so neighbours never repeat.
    const endpoints = [
      ["billing.example/in", [204]],
      ["ops.example/alerts", [502, 204]],
      ["crm.example/in", [500, 500, 500, 500, 500, 500, 500, 500]],
      ["acme.com/webhooks", [204]],
      ["shop.example/hooks", [503, 503, 204]],
    ];
    const events = [
      "invoice.paid",
      "customer.updated",
      "subscription.renewed",
      "invoice.paid",
      "refund.created",
    ];
    const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
    const msgId = () =>
      `msg_${Array.from({ length: 26 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("")}`;
    const ARRIVE_EVERY = 3.4;
    const TICK = 0.45;
    const VISIBLE = 3;
    let clock = 0;
    let nextArrival = 1.2;
    let n = 0;
    let paused = false;
    let hovered = false;
    const active = [];

    const chip = (code, tone) => {
      const el = document.createElement("span");
      el.className = `attempt ${tone} pop`;
      el.textContent = code;
      return el;
    };
    const setStatus = (row, cls, text, small) => {
      const status = row.querySelector(".status");
      status.className = `status ${cls}`;
      status.textContent = text;
      const s = document.createElement("small");
      s.textContent = small;
      status.append(s);
    };
    const sizeToRows = () => {
      const rows = [...list.children].slice(0, VISIBLE);
      list.style.height = `${rows.reduce((sum, r) => sum + r.offsetHeight, 0)}px`;
    };

    const arrive = () => {
      const [url, codes] = endpoints[n % endpoints.length];
      const event = events[n % events.length];
      n++;
      const row = document.createElement("div");
      row.className = "log-row";
      row.innerHTML = `<div class="endpoint"><b></b><small></small></div><div class="slots">${'<div class="slot"></div>'.repeat(8)}</div><div class="status"></div>`;
      row.querySelector("b").textContent = url;
      row.querySelector("small").textContent = event;
      setStatus(row, "live", "Delivering", "attempt 1");
      idLabel.textContent = msgId();

      // FLIP: note where the rows are, insert, then slide them from there.
      const before = new Map(
        [...list.children].map((r) => [r, r.getBoundingClientRect().top]),
      );
      list.prepend(row);
      while (list.children.length > VISIBLE + 1) list.lastElementChild.remove();
      for (const [r, top] of before) {
        if (!r.isConnected) continue;
        r.style.transition = "none";
        r.style.transform = `translateY(${top - r.getBoundingClientRect().top}px)`;
      }
      row.style.transition = "none";
      row.style.opacity = "0";
      row.style.transform = "translateY(-10px)";
      row.dataset.new = "";
      list.offsetHeight;
      for (const r of list.children) {
        r.style.transition =
          "transform 560ms cubic-bezier(0.32, 0.72, 0, 1), opacity 320ms ease-out";
        r.style.transform = "";
        r.style.opacity = "";
      }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => delete row.dataset.new),
      );
      active.push({ row, codes, i: 0, at: clock + 0.35 });
    };

    const step = () => {
      for (let k = active.length - 1; k >= 0; k--) {
        const d = active[k];
        if (clock < d.at) continue;
        if (!d.row.isConnected) {
          active.splice(k, 1);
          continue;
        }
        const code = d.codes[d.i];
        const last = d.i === d.codes.length - 1;
        const tone = code < 300 ? "ok" : d.codes.at(-1) >= 300 ? "bad" : "warn";
        d.row.querySelectorAll(".slot")[d.i].append(chip(code, tone));
        d.i++;
        if (last) {
          const ok = code < 300;
          setStatus(
            d.row,
            ok ? "ok" : "bad",
            ok ? "Succeeded" : "Failed",
            `${d.i} attempt${d.i > 1 ? "s" : ""}`,
          );
          active.splice(k, 1);
        } else {
          setStatus(d.row, "live", "Retrying", `attempt ${d.i + 1} of 8`);
          d.at = clock + TICK;
        }
      }
    };

    let last = 0;
    whileVisible(
      logWindow,
      (now) => {
        const dt = Math.min(0.1, (now - (last || now)) / 1000);
        last = now;
        if (paused || hovered) return;
        clock += dt;
        if (clock >= nextArrival) {
          nextArrival = clock + ARRIVE_EVERY;
          arrive();
        }
        step();
      },
      "0px",
    );

    list.dataset.live = "";
    sizeToRows();
    let width = 0;
    new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) < 1) return;
      width = entry.contentRect.width;
      sizeToRows();
    }).observe(logWindow);
    toggle.hidden = false;
    // A way to stop the moving content for everyone (WCAG 2.2.2).
    toggle.addEventListener("click", () => {
      paused = !paused;
      toggle.toggleAttribute("data-paused", paused);
      toggle.setAttribute(
        "aria-label",
        paused ? "Resume live updates" : "Pause live updates",
      );
      toggle.querySelector(".live-label").textContent = paused
        ? "Paused"
        : "Live";
    });
    if (finePointer) {
      logWindow.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") hovered = true;
      });
      logWindow.addEventListener("pointerleave", () => {
        hovered = false;
      });
    }
  }
}
