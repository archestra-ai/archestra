import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => {
  return {
    resizeHandler: null as
      | ((dimensions: { cols: number; rows: number }) => void)
      | null,
    wheelHandler: null as (() => boolean) | null,
    openedElement: null as HTMLDivElement | null,
    buffer: { active: { type: "normal", baseY: 100, viewportY: 100 } },
    scrollLines: vi.fn(),
    emitResize(cols: number, rows: number) {
      this.resizeHandler?.({ cols, rows });
    },
    processWheel() {
      return this.wheelHandler?.();
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    rows = 24;
    buffer = terminalHarness.buffer;
    scrollLines = terminalHarness.scrollLines;
    loadAddon() {}
    open(element: HTMLDivElement) {
      terminalHarness.openedElement = element;
    }
    dispose() {}
    write() {}
    onData() {}
    attachCustomWheelEventHandler(handler: () => boolean) {
      terminalHarness.wheelHandler = handler;
    }
    onResize(handler: (dimensions: { cols: number; rows: number }) => void) {
      terminalHarness.resizeHandler = handler;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { type ExecSessionTransport, ExecTerminal } from "./exec-terminal";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe("ExecTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalHarness.resizeHandler = null;
    terminalHarness.wheelHandler = null;
    terminalHarness.openedElement = null;
    terminalHarness.buffer.active.baseY = 100;
    terminalHarness.buffer.active.viewportY = 100;
    terminalHarness.scrollLines.mockReset();
  });

  it("keeps the remote PTY synchronized with xterm dimension changes", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-1" transport={transport} isActive />);

    await screen.findByText("Connected");
    vi.mocked(transport.sendResize).mockClear();

    terminalHarness.emitResize(164, 52);

    await waitFor(() => {
      expect(transport.sendResize).toHaveBeenCalledWith(164, 52);
    });
  });

  it("does not turn wheel motion over tmux into remote terminal input", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-1" transport={transport} isActive />);

    await screen.findByText("Connected");
    expect(terminalHarness.processWheel()).toBe(false);
  });

  it("scrolls the local transcript without sending wheel input remotely", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-1" transport={transport} isActive />);

    await screen.findByText("Connected");
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -32,
    });
    terminalHarness.openedElement?.dispatchEvent(wheel);

    expect(terminalHarness.scrollLines).toHaveBeenCalledWith(-2);
    expect(wheel.defaultPrevented).toBe(true);
    expect(transport.sendInput).not.toHaveBeenCalled();
  });

  it("hands wheel motion to the page at the transcript boundary", async () => {
    terminalHarness.buffer.active.baseY = 0;
    terminalHarness.buffer.active.viewportY = 0;
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-1" transport={transport} isActive />);

    await screen.findByText("Connected");
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 32,
    });
    terminalHarness.openedElement?.dispatchEvent(wheel);

    expect(terminalHarness.scrollLines).not.toHaveBeenCalled();
    expect(wheel.defaultPrevented).toBe(false);
    expect(transport.sendInput).not.toHaveBeenCalled();
  });
});
