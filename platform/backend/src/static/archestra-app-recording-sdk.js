// Archestra app-session recording SDK — the capture + replay half of the
// injected Apps SDK. Served APPENDED to archestra-app-sdk.js (see server.ts)
// only when app session recording is enabled, so disabled deployments never
// deliver this code to apps and removing the feature is deleting this file.
// ── Session recorder + replay driver ──────────────────────────────────────
// Powers the host's "Record session" demos. Dormant until the trusted host
// posts a recording-control message (relayed through the sandbox proxy):
//  - record mode captures pointer/keyboard/input/scroll/viewport activity and
//    posts it up in batches ({type:"mcp-apps:recording-event", events}) —
//    the same lane shape as diagnostics; the host discards batches unless the
//    user is actively recording.
//  - replay mode re-drives recorded events against a fresh instance of the
//    app: a virtual cursor, coordinate-dispatched mouse events, native-setter
//    input values (synthetic keys cannot type), key events for app listeners,
//    and scroll restoration. Best-effort by design — a failed step must never
//    break the app.
(() => {
  const CONTROL_TYPE = "mcp-apps:recording-control";
  const REPLAY_TYPE = "mcp-apps:replay-control";
  const EVENT_TYPE = "mcp-apps:recording-event";
  const FLUSH_INTERVAL_MS = 250;
  const FLUSH_BUFFER_MAX = 200;
  const MOVE_SAMPLE_MS = 40;
  const SCROLL_SAMPLE_MS = 100;

  let recording = false;
  let buffer = [];
  let flushTimer = null;
  let lastMoveTs = 0;
  let lastScrollTs = 0;
  let teardownFns = [];


  const post = (msg) => {
    try {
      window.parent.postMessage(msg, "*");
    } catch {
      // never let recording break the app
    }
  };

  const flush = () => {
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    post({ type: EVENT_TYPE, events });
  };

  // Events carry an absolute epoch `ts`; the host rebases them onto the
  // recording clock (same machine, same clock).
  const push = (event) => {
    if (!recording) return;
    event.ts = Date.now();
    buffer.push(event);
    if (buffer.length >= FLUSH_BUFFER_MAX) flush();
  };

  // Replay-resilient selector: a unique id when there is one, otherwise a
  // structural :nth-of-type path. The replayed app is the same HTML fed the
  // same recorded MCP responses, so structural paths resolve to the same
  // nodes they were captured on.
  const selectorFor = (el) => {
    try {
      if (
        el.id &&
        document.querySelectorAll("#" + CSS.escape(el.id)).length === 1
      ) {
        return "#" + CSS.escape(el.id);
      }
    } catch {
      // CSS.escape unavailable or exotic id — fall through to the path
    }
    const path = [];
    let node = el;
    while (
      node &&
      node.nodeType === 1 &&
      node !== document.documentElement
    ) {
      let index = 1;
      let sibling = node;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === node.tagName) index++;
      }
      path.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
      node = node.parentElement;
    }
    return path.length ? "html > " + path.join(" > ") : "html";
  };

  // Anchor a pointer event to its target element: the selector plus the
  // pointer's offset within the element's rect. The player replays the app in
  // a viewport of ITS OWN size (never the recorded one), so the app lays out
  // differently and raw coordinates alone would drift off their elements —
  // replay re-resolves the anchor in the current layout instead.
  const targetAnchor = (e) => {
    try {
      const el = e.target && e.target.nodeType === 1 ? e.target : null;
      if (!el) return {};
      const rect = el.getBoundingClientRect();
      return {
        selector: selectorFor(el).slice(0, 1000),
        ox: Math.round(e.clientX - rect.left),
        oy: Math.round(e.clientY - rect.top),
      };
    } catch {
      return {};
    }
  };

  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    teardownFns.push(() => target.removeEventListener(type, handler, options));
  };

  // ── Output capture ──
  // What the app BECAME, not just what was done to it.
  //
  // Re-running an app from its recorded input only reproduces the session if
  // the app is a pure function of that input, and real ones are not: they draw
  // from Math.random, they run on their own clock, they read state the host
  // holds. A recorded game replayed that way plays a different game. So the
  // visible result is recorded directly and replayed as itself.

  /**
   * Canvas pixels.
   *
   * A canvas is invisible to a MutationObserver — an app can repaint its entire
   * screen without producing a single mutation — and its contents cannot be
   * re-derived from input. Sampled rather than hooked: wrapping every 2D
   * context method would be far more code and still miss WebGL. Frames are
   * emitted only when the bytes change, so a still or paused app costs nothing.
   */
  const CANVAS_SAMPLE_MS = 100;
  const canvasLastFrame = new WeakMap();
  let canvasTimer = null;
  const sampleCanvases = () => {
    let canvases;
    try {
      canvases = document.querySelectorAll("canvas");
    } catch {
      return;
    }
    for (const canvas of canvases) {
      let data;
      try {
        // WebP keeps a flat-colour game screen to a couple of kilobytes. A
        // canvas holding cross-origin pixels is tainted and throws — skip it
        // rather than let a recording break the app.
        data = canvas.toDataURL("image/webp", 0.85);
      } catch {
        continue;
      }
      if (canvasLastFrame.get(canvas) === data) continue;
      canvasLastFrame.set(canvas, data);
      push({ kind: "canvas", sel: selectorFor(canvas).slice(0, 1000), data });
    }
  };

  /**
   * DOM changes, as the smallest re-renderable unit: the changed element's own
   * markup for structure and text, a single value for an attribute.
   */
  let domObserver = null;
  const startDomCapture = () => {
    if (typeof MutationObserver !== "function") return;
    domObserver = new MutationObserver((records) => {
      // One emission per element per batch — a burst of text changes inside the
      // same node is one new innerHTML, not twenty.
      const html = new Set();
      for (const record of records) {
        try {
          if (record.type === "attributes") {
            const el = record.target;
            if (!el || el.nodeType !== 1) continue;
            push({
              kind: "dom",
              op: "attr",
              sel: selectorFor(el).slice(0, 1000),
              name: record.attributeName,
              value: el.getAttribute(record.attributeName),
            });
          } else {
            const el =
              record.target.nodeType === 1
                ? record.target
                : record.target.parentElement;
            if (el) html.add(el);
          }
        } catch {
          // a single unreadable record must never stop the capture
        }
      }
      for (const el of html) {
        try {
          push({
            kind: "dom",
            op: "html",
            sel: selectorFor(el).slice(0, 1000),
            html: el.innerHTML,
          });
        } catch {}
      }
    });
    try {
      domObserver.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      domObserver = null;
    }
  };


  const startRecording = () => {
    if (recording) return;
    recording = true;
    buffer = [];
    push({
      kind: "viewport",
      width: window.innerWidth,
      height: window.innerHeight,
    });
    flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
    // What the app becomes, alongside what is done to it.
    startDomCapture();
    sampleCanvases();
    canvasTimer = setInterval(sampleCanvases, CANVAS_SAMPLE_MS);

    listen(window, "resize", () => {
      push({
        kind: "viewport",
        width: window.innerWidth,
        height: window.innerHeight,
      });
    });
    listen(
      document,
      "mousemove",
      (e) => {
        const now = Date.now();
        if (now - lastMoveTs < MOVE_SAMPLE_MS) return;
        lastMoveTs = now;
        push({
          kind: "pointer",
          type: "move",
          x: e.clientX,
          y: e.clientY,
          ...targetAnchor(e),
        });
      },
      true,
    );
    const pointerHandler = (type) => (e) => {
      push({
        kind: "pointer",
        type,
        x: e.clientX,
        y: e.clientY,
        button: e.button,
        ...targetAnchor(e),
      });
    };
    listen(document, "mousedown", pointerHandler("down"), true);
    listen(document, "mouseup", pointerHandler("up"), true);
    listen(document, "click", pointerHandler("click"), true);
    // Whether a node is a text-editable field — used to keep raw keystrokes
    // out of the recording (their effect is reproduced from the committed
    // input value instead, which is redacted for secret fields).
    const isEditableTarget = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      if (tag !== "INPUT") return false;
      const type = (el.type || "text").toLowerCase();
      return type !== "checkbox" && type !== "radio" && type !== "button";
    };
    const keyHandler = (type) => (e) => {
      // Never record the literal characters typed into an editable field: for
      // a printable key `e.key`/`e.code` are the character itself, so logging
      // them would leak a password one keystroke at a time and defeat the
      // value-level mask below. Replay reproduces text entry from the
      // (redacted) committed value, not from synthetic key events — so only
      // control keys (Enter/Tab/Escape/arrows) and modifier chords
      // (Ctrl/Cmd/Alt shortcuts) need recording here.
      const printable = String(e.key).length === 1;
      const modifierChord = e.ctrlKey || e.metaKey || e.altKey;
      if (printable && !modifierChord && isEditableTarget(e.target)) return;
      push({
        kind: "key",
        type,
        key: String(e.key).slice(0, 32),
        code: String(e.code).slice(0, 64),
        alt: e.altKey || undefined,
        ctrl: e.ctrlKey || undefined,
        meta: e.metaKey || undefined,
        shift: e.shiftKey || undefined,
      });
    };
    listen(document, "keydown", keyHandler("down"), true);
    listen(document, "keyup", keyHandler("up"), true);
    // A field is treated as secret when its type is `password`, or when its
    // type/name/id/autocomplete hints at a credential — so a reveal-password
    // toggle (which flips type to `text`) and secret-bearing text fields
    // (API keys, OTP codes, card numbers) are masked too, not just literal
    // password inputs.
    const SECRET_HINT = /pass|secret|token|otp|one-?time|cvc|cvv|card|ssn|pin\b|credential|private[-_]?key/i;
    const isSecretField = (el) => {
      if ((el.type || "").toLowerCase() === "password") return true;
      const hint =
        (el.getAttribute("autocomplete") || "") +
        " " +
        (el.getAttribute("name") || "") +
        " " +
        (el.id || "");
      return SECRET_HINT.test(hint);
    };
    // Committed control values — replay sets these directly, so text entry
    // reproduces even though synthetic key events cannot type.
    const valueHandler = (e) => {
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      const entry = { kind: "input", selector: selectorFor(el).slice(0, 1000) };
      if (el.type === "checkbox" || el.type === "radio") {
        entry.checked = !!el.checked;
      } else {
        let value = String(el.value == null ? "" : el.value);
        // never capture secrets: a secret field records only a length mask
        if (isSecretField(el)) {
          value = "•".repeat(Math.min(value.length, 32));
        }
        entry.value = value.slice(0, 20000);
      }
      push(entry);
    };
    listen(document, "input", valueHandler, true);
    listen(document, "change", valueHandler, true);
    listen(
      document,
      "scroll",
      (e) => {
        const now = Date.now();
        if (now - lastScrollTs < SCROLL_SAMPLE_MS) return;
        lastScrollTs = now;
        const target = e.target;
        if (
          target === document ||
          target === document.documentElement ||
          target === document.body
        ) {
          push({
            kind: "scroll",
            selector: null,
            x: window.scrollX,
            y: window.scrollY,
          });
        } else if (target && target.nodeType === 1) {
          push({
            kind: "scroll",
            selector: selectorFor(target).slice(0, 1000),
            x: target.scrollLeft,
            y: target.scrollTop,
          });
        }
      },
      true,
    );
  };

  const stopRecording = () => {
    if (!recording) return;
    // One last look before the gate closes, so the recording ends on the frame
    // the app actually finished on rather than a sample interval short of it.
    sampleCanvases();
    recording = false;
    for (const fn of teardownFns) {
      try {
        fn();
      } catch {
        // teardown is best-effort
      }
    }
    teardownFns = [];
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (canvasTimer) {
      clearInterval(canvasTimer);
      canvasTimer = null;
    }
    if (domObserver) {
      // One last look, so the final frame and the last DOM change are in the
      // recording rather than a sample interval short of it.
      try {
        domObserver.disconnect();
      } catch {}
      domObserver = null;
    }
    flush();
  };

  // ── replay driver ──
  // The replayed pointer is an arrow, drawn as a white silhouette over a dark
  // outline — the way the player draws its own cursor glyphs, and the way the
  // OS draws the real one. A coloured dot reads as a recording light rather
  // than as the mouse, and a themed accent would disappear against the
  // background of whichever app is replaying; white over dark carries on all
  // of them. The viewBox is 1:1 with the rendered pixels, so the tip sits at
  // exactly (1,1) — that offset is the hotspot, and the transform origin, so
  // the point stays on the recorded coordinate through the press scale.
  const CURSOR_HOTSPOT = 1;
  let cursorEl = null;
  const ensureCursor = () => {
    if (cursorEl && cursorEl.isConnected) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.setAttribute("aria-hidden", "true");
    cursorEl.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;" +
      "transform-origin:1px 1px;transition:transform 60ms linear;" +
      "filter:drop-shadow(0 1px 3px rgba(0,0,0,.45));" +
      "transform:translate(-9999px,-9999px)";
    cursorEl.innerHTML =
      '<svg width="16" height="21" viewBox="0 0 16 21" style="display:block">' +
      '<path d="M1 1 L1 17.2 L5.1 13.4 L7.9 19.4 L10.9 18 L8.1 12.1 L14.2 12.1 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(cursorEl);
    return cursorEl;
  };
  let cursorX = -9999;
  let cursorY = -9999;
  let cursorDown = false;
  const paintCursor = () => {
    ensureCursor().style.transform =
      "translate(" +
      (cursorX - CURSOR_HOTSPOT) +
      "px," +
      (cursorY - CURSOR_HOTSPOT) +
      "px)" +
      (cursorDown ? " scale(.85)" : "");
  };
  const moveCursor = (x, y) => {
    cursorX = x;
    cursorY = y;
    paintCursor();
  };
  // The ripple below already says that a click happened, so the arrow only
  // dips under the press the way a real cursor appears to.
  const pressCursor = (down) => {
    cursorDown = down;
    paintCursor();
  };
  // A click has no visible effect when the app doesn't change on click, so the
  // replay would look inert. Paint a short expanding ring at the click point
  // so viewers can see where — and that — a click happened. Best-effort and
  // self-removing; never blocks the app.
  const spawnClickRipple = (x, y) => {
    try {
      const ripple = document.createElement("div");
      ripple.setAttribute("aria-hidden", "true");
      ripple.style.cssText =
        "position:fixed;left:" +
        (x - 8) +
        "px;top:" +
        (y - 8) +
        "px;width:16px;height:16px;border-radius:50%;" +
        "border:2px solid rgba(37,99,235,.8);box-sizing:border-box;" +
        "z-index:2147483646;pointer-events:none;opacity:.9;" +
        "transition:transform 420ms ease-out,opacity 420ms ease-out;" +
        "transform:scale(.4)";
      (document.body || document.documentElement).appendChild(ripple);
      requestAnimationFrame(() => {
        ripple.style.transform = "scale(2.6)";
        ripple.style.opacity = "0";
      });
      setTimeout(() => ripple.remove(), 480);
    } catch {
      // click affordance is best-effort
    }
  };
  // React and friends patch value setters on instances; going through the
  // prototype's native setter makes the framework see the change.
  const nativeSet = (el, prop, value) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el),
        prop,
      );
      if (desc && desc.set) {
        desc.set.call(el, value);
        return;
      }
    } catch {
      // fall through to direct assignment
    }
    el[prop] = value;
  };
  // Replay drives the app with synthetic events, and two kinds of chrome can
  // never be reproduced that way — documented limits, not bugs to chase: a
  // native <select>/date-picker popup only opens for a *trusted* gesture, and
  // the CSS :hover state follows the real hardware pointer, which never moved.
  // What IS reproducible is every DOM-based control — but a modern component
  // library (Radix/shadcn and friends) opens its menus on Pointer events, so
  // replay emits pointerdown/up/move next to the mouse events, and synthesizes
  // the over/out crossing so an app's (or React's) hover handlers fire.
  let hoverTarget = null;
  const PointerCtor = typeof PointerEvent === "function" ? PointerEvent : null;
  const POINTER_INIT = { pointerId: 1, pointerType: "mouse", isPrimary: true };
  const dispatchAt = (Ctor, target, type, x, y, button, extra) => {
    if (!target) return;
    try {
      target.dispatchEvent(
        new Ctor(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: button || 0,
          ...extra,
        }),
      );
    } catch {
      // dispatch is best-effort
    }
  };
  // Fire a pointer event (when the constructor exists) paired with its mouse
  // event at (x, y), so both Pointer- and Mouse-based components respond.
  const dispatchPointerAndMouse = (pointerType, mouseType, x, y, button) => {
    const target =
      document.elementFromPoint(x, y) ||
      document.body ||
      document.documentElement;
    if (!target) return null;
    if (PointerCtor && pointerType) {
      dispatchAt(PointerCtor, target, pointerType, x, y, button, POINTER_INIT);
    }
    if (mouseType) dispatchAt(MouseEvent, target, mouseType, x, y, button);
    return target;
  };
  // Synthesize the hover crossing when the element under the cursor changes:
  // out on the element left, over on the one entered. Both bubble, so React
  // derives onMouseEnter/onPointerEnter from them — that is what makes
  // JS-driven hover menus and highlights appear in replay. (Pure CSS :hover
  // still won't: it follows the real pointer, which never moved.)
  const updateHover = (x, y, target) => {
    if (target === hoverTarget) return;
    const from = hoverTarget;
    hoverTarget = target;
    const cross = (el, type, related) => {
      if (!el) return;
      if (PointerCtor) {
        dispatchAt(PointerCtor, el, "pointer" + type, x, y, 0, {
          ...POINTER_INIT,
          relatedTarget: related,
        });
      }
      dispatchAt(MouseEvent, el, "mouse" + type, x, y, 0, {
        relatedTarget: related,
      });
    };
    cross(from, "out", target);
    cross(target, "over", from);
  };
  // A native <select> popup is OS chrome and never opens from a synthetic
  // event, so a recorded "open the dropdown, pick an option" plays back inert.
  // Draw a stand-in option list instead: open it when a replayed click lands
  // on a <select>, highlight the chosen option when the value change replays,
  // then dismiss it. The stand-in is pointer-events:none and aria-hidden, so
  // it can never affect the app or be hit by elementFromPoint.
  let selectMenu = null; // { el, node, timer }
  const closeSelectMenu = () => {
    if (!selectMenu) return;
    clearTimeout(selectMenu.timer);
    if (selectMenu.node) selectMenu.node.remove();
    selectMenu = null;
  };
  const solidBackground = (el) => {
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) {
        return bg;
      }
      node = node.parentElement;
    }
    return null;
  };
  const openSelectMenu = (select) => {
    try {
      if (!select || select.disabled || select.multiple || select.size > 1) {
        return;
      }
      if (!select.options || select.options.length === 0) return;
      closeSelectMenu();
      const cs = getComputedStyle(select);
      const fg = cs.color || "#111";
      const bg = solidBackground(select) || "#ffffff";
      const rect = select.getBoundingClientRect();
      const node = document.createElement("div");
      node.setAttribute("aria-hidden", "true");
      // Set as properties, not as one concatenated `cssText`: several of these
      // values come from the app's own computed style, and a declaration that
      // is built by string-joining is one stray `;` away from meaning
      // something else entirely. A property setter cannot escape its own
      // declaration.
      Object.assign(node.style, {
        position: "fixed",
        left: rect.left + "px",
        top: rect.bottom + "px",
        minWidth: rect.width + "px",
        maxHeight: "260px",
        overflow: "hidden",
        boxSizing: "border-box",
        zIndex: "2147483640",
        pointerEvents: "none",
        background: bg,
        color: fg,
        border: "1px solid rgba(128,128,128,.4)",
        borderRadius: "6px",
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        padding: "4px 0",
        fontSize: cs.fontSize || "13px",
        fontFamily: cs.fontFamily || "system-ui,sans-serif",
      });
      for (const opt of Array.from(select.options)) {
        const item = document.createElement("div");
        item.textContent = opt.label || opt.textContent || opt.value || "";
        item.setAttribute("data-value", opt.value);
        Object.assign(item.style, {
          padding: "6px 12px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          background: opt.value === select.value ? "#2563eb" : "",
          color: opt.value === select.value ? "#fff" : "",
        });
        node.appendChild(item);
      }
      (document.body || document.documentElement).appendChild(node);
      // Flip above the control if the list would overflow the viewport bottom.
      const h = node.getBoundingClientRect().height;
      if (rect.bottom + h > window.innerHeight && rect.top - h > 0) {
        node.style.top = rect.top - h + "px";
      }
      // Safety dismissal so a dropdown whose selection is never replayed
      // (opened, then clicked away) doesn't linger.
      const timer = setTimeout(closeSelectMenu, 2500);
      selectMenu = { el: select, node, timer };
    } catch {
      // stand-in dropdown is best-effort
    }
  };
  // The value change landed: highlight the picked option, then dismiss.
  const resolveSelectMenu = (select) => {
    if (!selectMenu || selectMenu.el !== select) return;
    try {
      for (const item of Array.from(selectMenu.node.children)) {
        const on = item.getAttribute("data-value") === select.value;
        item.style.background = on ? "#2563eb" : "";
        item.style.color = on ? "#fff" : "";
      }
      clearTimeout(selectMenu.timer);
      selectMenu.timer = setTimeout(closeSelectMenu, 450);
    } catch {
      closeSelectMenu();
    }
  };
  // Re-anchor a recorded pointer event in the current layout. The replayed
  // app lays out at the player's own viewport — never the recorded one — so
  // the recorded target element is re-resolved and the pointer aimed at the
  // same spot within it. An interaction whose target sits outside this
  // viewport scrolls it into view first (the recorded session's visible area,
  // brought on screen as needed). Events without an anchor (older recordings)
  // fall back to their raw coordinates.
  const resolveReplayPoint = (event) => {
    const fallback = { x: event.x, y: event.y };
    if (!event.selector) return fallback;
    try {
      const el = document.querySelector(event.selector);
      if (!el) return fallback;
      let rect = el.getBoundingClientRect();
      const offscreen =
        rect.bottom < 0 ||
        rect.right < 0 ||
        rect.top > window.innerHeight ||
        rect.left > window.innerWidth;
      // Only interactions pull their target into view; a passing move just
      // tracks it (scrolling on every hover sample would thrash the page).
      if (offscreen && (event.type === "down" || event.type === "click")) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        rect = el.getBoundingClientRect();
      }
      const ox =
        typeof event.ox === "number"
          ? Math.max(0, Math.min(event.ox, rect.width))
          : rect.width / 2;
      const oy =
        typeof event.oy === "number"
          ? Math.max(0, Math.min(event.oy, rect.height))
          : rect.height / 2;
      return { x: rect.left + ox, y: rect.top + oy };
    } catch {
      return fallback;
    }
  };

  const applyReplayEvent = (event) => {
    try {
      if (event.kind === "pointer") {
        const point = resolveReplayPoint(event);
        moveCursor(point.x, point.y);
        if (event.type === "move") {
          const target = dispatchPointerAndMouse(
            "pointermove",
            "mousemove",
            point.x,
            point.y,
            0,
          );
          updateHover(point.x, point.y, target);
        } else if (event.type === "down") {
          pressCursor(true);
          spawnClickRipple(point.x, point.y);
          const downTarget = dispatchPointerAndMouse(
            "pointerdown",
            "mousedown",
            point.x,
            point.y,
            event.button,
          );
          // A click on a native <select> opens the stand-in option list.
          const select =
            downTarget && downTarget.closest
              ? downTarget.closest("select")
              : null;
          if (select) openSelectMenu(select);
        } else if (event.type === "up") {
          pressCursor(false);
          dispatchPointerAndMouse(
            "pointerup",
            "mouseup",
            point.x,
            point.y,
            event.button,
          );
        } else if (event.type === "click") {
          // Read-only replay must never move REAL focus into the frame: the
          // host keeps keyboard focus so viewer keystrokes drive the player,
          // not the app (a focused button would otherwise eat Space/Enter).
          // The synthetic click alone reproduces the app's click behavior.
          dispatchPointerAndMouse(
            null,
            "click",
            point.x,
            point.y,
            event.button,
          );
        }
      } else if (event.kind === "key") {
        const target = document.activeElement || document.body || document;
        target.dispatchEvent(
          new KeyboardEvent(event.type === "down" ? "keydown" : "keyup", {
            bubbles: true,
            cancelable: true,
            key: event.key,
            code: event.code,
            altKey: !!event.alt,
            ctrlKey: !!event.ctrl,
            metaKey: !!event.meta,
            shiftKey: !!event.shift,
          }),
        );
      } else if (event.kind === "input") {
        const el = event.selector
          ? document.querySelector(event.selector)
          : null;
        if (!el) return;
        // Value is committed via the native setter + input/change below; no
        // real focus() — the read-only frame must not hold keyboard focus.
        if (typeof event.checked === "boolean") {
          nativeSet(el, "checked", event.checked);
        } else if (typeof event.value === "string") {
          nativeSet(el, "value", event.value);
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // Land the selection in the stand-in dropdown, if one is open.
        if (el.tagName === "SELECT") resolveSelectMenu(el);
      } else if (event.kind === "scroll") {
        if (event.selector) {
          const el = document.querySelector(event.selector);
          if (el) {
            el.scrollLeft = event.x;
            el.scrollTop = event.y;
          }
        } else {
          window.scrollTo(event.x, event.y);
        }
      }
      // viewport/mcp/segment events are handled host-side.
    } catch {
      // replay is best-effort; never break the app
    }
  };

  // ── Pause freeze: while the replay is paused, halt the app's own motion so
  // nothing keeps moving inside the frame. CSS animations/transitions pause via
  // an injected style; requestAnimationFrame, setTimeout, and setInterval
  // callbacks are held and re-armed on resume with the time they had left, so
  // rAF-, timeout-, and interval-driven motion all freeze.
  let replayFrozen = false;
  let freezeStyleEl = null;
  const rafQueue = [];
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    if (replayFrozen) {
      rafQueue.push(cb);
      return 0;
    }
    return origRaf(cb);
  };


  // Virtual-clock timers: track each so it can be cancelled on pause and
  // re-armed on resume with its remaining delay, rather than firing while
  // frozen. Fake ids start high to avoid colliding with native timer ids.
  const nowMs = () =>
    window.performance && performance.now ? performance.now() : Date.now();
  const origSetTimeout = window.setTimeout.bind(window);
  const origClearTimeout = window.clearTimeout.bind(window);
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const timers = new Map();
  let nextTimerId = 900719925;
  const armTimer = (id, rec) => {
    rec.dueAt = nowMs() + rec.remaining;
    const fire = () => {
      if (rec.kind === "interval") {
        rec.remaining = rec.period;
        rec.dueAt = nowMs() + rec.period;
        rec.realId = origSetTimeout(fire, rec.period);
      } else {
        timers.delete(id);
      }
      try {
        rec.cb.apply(undefined, rec.args);
      } catch (_) {}
    };
    rec.realId = origSetTimeout(fire, rec.remaining);
  };
  window.setTimeout = function (cb) {
    if (typeof cb !== "function")
      return origSetTimeout.apply(window, arguments);
    const id = ++nextTimerId;
    const rec = {
      kind: "timeout",
      cb,
      args: Array.prototype.slice.call(arguments, 2),
      remaining: Math.max(0, +arguments[1] || 0),
    };
    timers.set(id, rec);
    if (!replayFrozen) armTimer(id, rec);
    return id;
  };
  window.setInterval = function (cb) {
    if (typeof cb !== "function")
      return origSetInterval.apply(window, arguments);
    const id = ++nextTimerId;
    const period = Math.max(4, +arguments[1] || 0);
    const rec = {
      kind: "interval",
      cb,
      args: Array.prototype.slice.call(arguments, 2),
      remaining: period,
      period,
    };
    timers.set(id, rec);
    if (!replayFrozen) armTimer(id, rec);
    return id;
  };
  window.clearTimeout = (id) => {
    const rec = timers.get(id);
    if (rec) {
      if (rec.realId != null) origClearTimeout(rec.realId);
      timers.delete(id);
    } else origClearTimeout(id);
  };
  window.clearInterval = (id) => {
    const rec = timers.get(id);
    if (rec) {
      if (rec.realId != null) origClearTimeout(rec.realId);
      timers.delete(id);
    } else origClearInterval(id);
  };

  /**
   * Put a recorded piece of the app's output back on screen.
   *
   * The replayed document runs none of the app's own code, so nothing here is
   * competing with a live app: these ARE the app, played back. A step that
   * cannot be applied is skipped rather than allowed to stop the replay — one
   * missing element must not cost every frame after it.
   */
  const paintRecordedOutput = (event) => {
    try {
      if (event.kind === "canvas") {
        const canvas = document.querySelector(event.sel);
        if (!canvas || !canvas.getContext) return;
        const image = new Image();
        image.onload = () => {
          try {
            // Restore the canvas's own bitmap size before drawing. The frame
            // already carries it — toDataURL captures at canvas.width ×
            // canvas.height — and replay needs it because it serves the app's
            // SOURCE html and never runs the app's code: a canvas the app
            // sized in its own JS is still at the HTML default 300x150 here,
            // so drawing a full frame into it squeezed the whole app down to a
            // thumbnail while the markup around it stayed full size. Assigning
            // width resets the bitmap, so only on an actual change.
            if (canvas.width !== image.naturalWidth) {
              canvas.width = image.naturalWidth;
            }
            if (canvas.height !== image.naturalHeight) {
              canvas.height = image.naturalHeight;
            }
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          } catch {}
        };
        image.src = event.data;
        return;
      }
      if (event.kind === "dom") {
        const el = document.querySelector(event.sel);
        if (!el) return;
        if (event.op === "attr") {
          // An `on*` attribute is code, not state: restoring one would arm a
          // handler in a replay whose whole premise is that the app does not
          // run again.
          if (isHandlerAttr(event.name)) return;
          if (event.value === null || event.value === undefined) {
            el.removeAttribute(event.name);
          } else {
            el.setAttribute(event.name, event.value);
          }
        } else if (typeof event.html === "string") {
          el.replaceChildren(inertMarkup(event.html));
        }
      }
    } catch {
      // best effort, always
    }
  };

  const isHandlerAttr = (name) =>
    typeof name === "string" && /^on/i.test(name);

  /**
   * Parse recorded markup into an inert fragment, with anything that would run
   * removed.
   *
   * A replay shows what the app produced; it must never run the app a second
   * time. Script elements are re-typed before the document loads, but a DOM
   * snapshot taken mid-session can still carry inline handlers — and an
   * `onerror` on a broken image needs no interaction at all to fire. A
   * `<template>`'s content is inert, so parsing here neither loads a resource
   * nor executes anything; what it yields is then stripped of both.
   */
  const inertMarkup = (html) => {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const node of template.content.querySelectorAll("script")) {
      node.remove();
    }
    for (const node of template.content.querySelectorAll("*")) {
      for (const attr of Array.from(node.attributes)) {
        if (isHandlerAttr(attr.name)) node.removeAttribute(attr.name);
      }
    }
    return template.content;
  };

  const freezeReplay = () => {
    if (replayFrozen) return;
    replayFrozen = true;
    if (!freezeStyleEl) {
      freezeStyleEl = document.createElement("style");
      freezeStyleEl.textContent =
        "*,*::before,*::after{animation-play-state:paused!important;transition:none!important}";
    }
    (document.head || document.documentElement).appendChild(freezeStyleEl);
    const t = nowMs();
    timers.forEach((rec) => {
      if (rec.realId != null) {
        origClearTimeout(rec.realId);
        rec.realId = null;
        rec.remaining = Math.max(0, (rec.dueAt != null ? rec.dueAt : t) - t);
      }
    });
  };
  const unfreezeReplay = () => {
    if (!replayFrozen) return;
    replayFrozen = false;
    if (freezeStyleEl && freezeStyleEl.parentNode) freezeStyleEl.remove();
    timers.forEach((rec, id) => {
      if (rec.realId == null) armTimer(id, rec);
    });
    const queued = rafQueue.splice(0);
    for (const cb of queued) origRaf(cb);
  };

  window.addEventListener("message", (e) => {
    // Only the parent chain (the trusted host via the sandbox proxy relay)
    // may drive recording/replay.
    if (e.source !== window.parent) return;
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.type === CONTROL_TYPE) {
      if (data.action === "start") startRecording();
      else if (data.action === "stop") stopRecording();
    } else if (data.type === REPLAY_TYPE) {
      if (data.action === "apply" && data.event) {
        applyReplayEvent(data.event);
      } else if (data.action === "reset") {
        if (cursorEl) {
          cursorEl.remove();
          cursorEl = null;
        }
        hoverTarget = null;
        closeSelectMenu();
      } else if (data.action === "paint" && data.event) {
        paintRecordedOutput(data.event);
      } else if (data.action === "pause") {
        freezeReplay();
      } else if (data.action === "resume") {
        unfreezeReplay();
      }
    }
  });
})();
