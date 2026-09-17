import type { Terminal } from "@xterm/xterm";

export function attachBrowserSelection(
  terminal: Terminal,
  isMouseControlEnabled: () => boolean,
): () => void {
  const element = terminal.element;
  if (!element) return () => {};
  // Match xterm 6's platform check: Next's process shim selects its non-Mac path.
  const isMac =
    !(typeof process !== "undefined" && "title" in process) &&
    /Mac/.test(navigator.platform);
  const localEvents = new WeakSet<MouseEvent>();

  const selectLocally = (event: MouseEvent) => {
    if (
      localEvents.has(event) ||
      isMouseControlEnabled() ||
      terminal.modes.mouseTrackingMode === "none" ||
      !(event.target instanceof Element)
    ) {
      return;
    }

    // xterm 6 exposes modifier-selection, but no mouse-selection override.
    // Reuse its selection handling so word selection, dragging and copying
    // stay local without disabling the application's wheel reporting.
    const localEvent = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      view: event.view,
      detail: event.detail,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      button: event.button,
      buttons: event.buttons,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: isMac,
      shiftKey: !isMac,
    });
    localEvents.add(localEvent);
    event.preventDefault();
    event.stopImmediatePropagation();
    event.target.dispatchEvent(localEvent);
  };

  element.addEventListener("mousedown", selectLocally, true);
  return () => element.removeEventListener("mousedown", selectLocally, true);
}
