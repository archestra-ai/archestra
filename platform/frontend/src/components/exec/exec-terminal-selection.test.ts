import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachBrowserSelection } from "./exec-terminal-selection";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("browser terminal selection", () => {
  it.each([
    "MacIntel",
    "Linux x86_64",
  ])("keeps ordinary clicks local in a mouse-tracking terminal on %s", (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const { element, target, terminal } = fixture();
    const remoteMouse = vi.fn();
    const localSelection = vi.fn();
    const originalProcess = globalThis.process;
    vi.stubGlobal("process", undefined);
    const detach = attachBrowserSelection(terminal, () => false);
    vi.stubGlobal("process", originalProcess);
    element.addEventListener("mousedown", (event) => {
      const forceSelection =
        platform === "MacIntel" ? event.altKey : event.shiftKey;
      if (forceSelection)
        localSelection(event.clientX, event.clientY, event.detail);
      else remoteMouse();
    });

    target.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 20,
        detail: 2,
      }),
    );

    expect(localSelection).toHaveBeenCalledExactlyOnceWith(40, 20, 2);
    expect(remoteMouse).not.toHaveBeenCalled();
    detach();
  });

  it("allows explicit mouse control and removes the override on detach", () => {
    const { element, target, terminal } = fixture();
    let mouseControl = false;
    const detach = attachBrowserSelection(terminal, () => mouseControl);
    const received: MouseEvent[] = [];
    element.addEventListener("mousedown", (event) => received.push(event));
    mouseControl = true;
    const controlled = [0, 1, 2].map(
      (button) => new MouseEvent("mousedown", { bubbles: true, button }),
    );
    for (const event of controlled) target.dispatchEvent(event);
    mouseControl = false;
    detach();
    const detached = new MouseEvent("mousedown", { bubbles: true });
    target.dispatchEvent(detached);

    expect(received).toEqual([...controlled, detached]);
  });

  it("uses xterm's non-Mac selection modifier when a process shim is present", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { element, target, terminal } = fixture();
    const received: MouseEvent[] = [];
    const detach = attachBrowserSelection(terminal, () => false);
    element.addEventListener("mousedown", (event) => received.push(event));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(received).toHaveLength(1);
    expect(received[0].shiftKey).toBe(true);
    expect(received[0].altKey).toBe(false);
    detach();
  });

  it("preserves ordinary selection modifiers when mouse tracking is off", () => {
    const { element, target, terminal } = fixture("none");
    const detach = attachBrowserSelection(terminal, () => false);
    const received: MouseEvent[] = [];
    element.addEventListener("mousedown", (event) => received.push(event));
    const shiftClick = new MouseEvent("mousedown", {
      bubbles: true,
      shiftKey: true,
    });
    target.dispatchEvent(shiftClick);

    expect(received).toEqual([shiftClick]);
    detach();
  });
});

function fixture(mouseTrackingMode: "any" | "none" = "any") {
  const element = document.createElement("div");
  const target = document.createElement("span");
  element.append(target);
  document.body.append(element);
  const terminal = {
    element,
    modes: { mouseTrackingMode },
  } as unknown as Terminal;
  return { element, target, terminal };
}
