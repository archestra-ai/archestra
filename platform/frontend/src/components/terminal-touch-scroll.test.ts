import type { Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachTerminalTouchScroll } from "./terminal-touch-scroll";

describe("terminal touch scrolling", () => {
  let container: HTMLDivElement;
  let screen: HTMLDivElement;
  let terminal: Terminal;
  let scrollLines: ReturnType<typeof vi.fn>;
  let wheel: ReturnType<typeof vi.fn<(event: WheelEvent) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    screen = document.createElement("div");
    screen.className = "xterm-screen";
    container.append(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 240, height: 240 }) as DOMRect;
    scrollLines = vi.fn();
    wheel = vi.fn();
    container.addEventListener("wheel", wheel);
    terminal = {
      rows: 24,
      modes: { mouseTrackingMode: "none" },
      buffer: { active: { type: "normal" } },
      scrollLines,
    } as unknown as Terminal;
  });

  it("scrolls local history in both directions and accumulates sub-line movement", () => {
    attachTerminalTouchScroll({ container, terminal });
    touch(screen, { type: "touchstart", y: 100 });
    expect(touch(screen, { type: "touchmove", y: 124 }).defaultPrevented).toBe(
      true,
    );
    expect(scrollLines).toHaveBeenLastCalledWith(-2);
    touch(screen, { type: "touchmove", y: 130 });
    expect(scrollLines).toHaveBeenLastCalledWith(-1);
    touch(screen, { type: "touchmove", y: 110 });
    expect(scrollLines).toHaveBeenLastCalledWith(2);
    expect(wheel).not.toHaveBeenCalled();
  });

  it("routes swipes to xterm wheel handling when the remote TUI owns scrolling", () => {
    Object.assign(terminal.modes, { mouseTrackingMode: "drag" });
    attachTerminalTouchScroll({ container, terminal });
    touch(screen, { type: "touchstart", y: 100 });
    touch(screen, { type: "touchmove", y: 130 });
    expect(wheel).toHaveBeenCalledTimes(3);
    expect(wheel.mock.calls[0][0]).toMatchObject({
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: -1,
      clientX: 50,
      clientY: 130,
    });
    expect(scrollLines).not.toHaveBeenCalled();
  });

  it("keeps recording scrolling local even if captured bytes enabled mouse tracking", () => {
    Object.assign(terminal.modes, { mouseTrackingMode: "drag" });
    attachTerminalTouchScroll({ container, terminal, readOnly: true });
    touch(screen, { type: "touchstart", y: 100 });
    touch(screen, { type: "touchmove", y: 130 });
    expect(scrollLines).toHaveBeenCalledWith(-3);
    expect(wheel).not.toHaveBeenCalled();
  });

  it("accounts for a recording scaled down on a phone", () => {
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 120, height: 120 }) as DOMRect;
    attachTerminalTouchScroll({ container, terminal, readOnly: true });
    touch(screen, { type: "touchstart", y: 50 });
    touch(screen, { type: "touchmove", y: 70 });
    expect(scrollLines).toHaveBeenCalledWith(-4);
  });

  it("leaves taps, horizontal drags, and multi-touch gestures to the browser", () => {
    attachTerminalTouchScroll({ container, terminal });
    touch(screen, { type: "touchstart", y: 100 });
    expect(touch(screen, { type: "touchmove", y: 103 }).defaultPrevented).toBe(
      false,
    );
    expect(
      touch(screen, { type: "touchmove", y: 110, x: 100 }).defaultPrevented,
    ).toBe(false);
    touch(screen, { type: "touchend", y: 110 });
    touch(screen, { type: "touchstart", y: 100 });
    const pinch = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.assign(pinch, { touches: [{ clientY: 130 }, { clientY: 150 }] });
    screen.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(false);
    touch(screen, { type: "touchmove", y: 160 });
    expect(scrollLines).not.toHaveBeenCalled();
    expect(wheel).not.toHaveBeenCalled();
  });

  it("scrolls an enlarged recording's canvas before its terminal history", () => {
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 600 },
    });
    viewport.scrollTop = 100;
    attachTerminalTouchScroll({
      container,
      terminal,
      readOnly: true,
      scrollViewport: viewport,
    });
    touch(screen, { type: "touchstart", y: 100 });
    touch(screen, { type: "touchmove", y: 150 });
    expect(viewport.scrollTop).toBe(50);
    expect(scrollLines).not.toHaveBeenCalled();
    touch(screen, { type: "touchmove", y: 200 });
    expect(viewport.scrollTop).toBe(0);
    touch(screen, { type: "touchmove", y: 220 });
    expect(scrollLines).toHaveBeenCalledWith(-2);
    screen.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 75 }),
    );
    expect(viewport.scrollTop).toBe(75);
    expect(wheel).not.toHaveBeenCalled();
  });

  it("stops handling gestures after disposal or cancellation", () => {
    const detach = attachTerminalTouchScroll({ container, terminal });
    touch(screen, { type: "touchstart", y: 100 });
    touch(screen, { type: "touchcancel", y: 100 });
    touch(screen, { type: "touchmove", y: 130 });
    detach();
    touch(screen, { type: "touchstart", y: 100 });
    touch(screen, { type: "touchmove", y: 130 });
    expect(scrollLines).not.toHaveBeenCalled();
  });
});

function touch(
  target: HTMLElement,
  { type, y, x = 50 }: { type: string; y: number; x?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { touches: [{ clientX: x, clientY: y }] });
  target.dispatchEvent(event);
  return event;
}
