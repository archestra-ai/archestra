import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => {
  return {
    resizeHandler: null as
      | ((dimensions: { cols: number; rows: number }) => void)
      | null,
    emitResize(cols: number, rows: number) {
      this.resizeHandler?.({ cols, rows });
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    rows = 24;
    loadAddon() {}
    open() {}
    dispose() {}
    write() {}
    onData() {}
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
});
