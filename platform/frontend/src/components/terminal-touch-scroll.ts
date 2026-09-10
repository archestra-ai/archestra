import type { Terminal } from "@xterm/xterm";

/** Route finger drags through the same scrolling path as a mouse wheel. */
export function attachTerminalTouchScroll({
  container,
  terminal,
  readOnly = false,
  scrollViewport,
}: {
  container: HTMLElement;
  terminal: Terminal;
  readOnly?: boolean;
  scrollViewport?: HTMLElement;
}): () => void {
  let gesture: { x: number; y: number; scrolling: boolean } | null = null;
  let remainder = 0;

  const end = () => {
    gesture = null;
    remainder = 0;
  };
  const start = (event: TouchEvent) => {
    end();
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    gesture = { x: touch.clientX, y: touch.clientY, scrolling: false };
  };
  const move = (event: TouchEvent) => {
    if (!gesture || event.touches.length !== 1) {
      end();
      return;
    }
    const touch = event.touches[0];
    const deltaY = gesture.y - touch.clientY;
    if (!gesture.scrolling) {
      if (Math.abs(deltaY) < 8) return;
      if (Math.abs(touch.clientX - gesture.x) > Math.abs(deltaY)) {
        end();
        return;
      }
      gesture.scrolling = true;
    }

    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const bounds = screen.getBoundingClientRect();
    const lineHeight = bounds.height / terminal.rows;
    if (lineHeight <= 0) return;

    // Capture before xterm's viewport can also consume the gesture. A tap
    // remains untouched, so it can still focus the terminal for typing.
    event.preventDefault();
    event.stopImmediatePropagation();
    gesture.y = touch.clientY;
    if (scrollViewport && scrollViewportBy(scrollViewport, deltaY)) {
      remainder = 0;
      return;
    }
    remainder += deltaY;
    const lines = Math.trunc(remainder / lineHeight);
    remainder -= lines * lineHeight;
    if (!lines) return;

    if (
      readOnly ||
      (terminal.modes.mouseTrackingMode === "none" &&
        terminal.buffer.active.type === "normal")
    ) {
      terminal.scrollLines(lines);
      return;
    }

    // Let xterm encode mouse reports for the negotiated protocol (or use
    // its alternate-screen wheel handling). In particular, tmux needs these
    // reports to enter copy mode and expose history held on the server.
    for (let index = 0; index < Math.abs(lines); index++) {
      screen.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: Math.sign(lines),
          clientX: Math.max(
            bounds.left,
            Math.min(touch.clientX, bounds.right - 1),
          ),
          clientY: Math.max(
            bounds.top,
            Math.min(touch.clientY, bounds.bottom - 1),
          ),
        }),
      );
    }
  };

  const wheel = (event: WheelEvent) => {
    if (!scrollViewport || event.ctrlKey) return;
    const delta =
      event.deltaY *
      (event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? scrollViewport.clientHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : 1);
    if (!scrollViewportBy(scrollViewport, delta)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  container.addEventListener("wheel", wheel, { passive: false, capture: true });
  container.addEventListener("touchstart", start, {
    passive: true,
    capture: true,
  });
  container.addEventListener("touchmove", move, {
    passive: false,
    capture: true,
  });
  container.addEventListener("touchend", end, true);
  container.addEventListener("touchcancel", end, true);
  return () => {
    container.removeEventListener("wheel", wheel, true);
    container.removeEventListener("touchstart", start, true);
    container.removeEventListener("touchmove", move, true);
    container.removeEventListener("touchend", end, true);
    container.removeEventListener("touchcancel", end, true);
  };
}

// A fitted portrait recording can be taller than its panel. Scroll that
// canvas before asking xterm for history above or below the recorded screen.
function scrollViewportBy(viewport: HTMLElement, delta: number): boolean {
  const previous = viewport.scrollTop;
  const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const next = Math.max(0, Math.min(maximum, previous + delta));
  if (next === previous) return false;
  viewport.scrollTop = next;
  return true;
}
