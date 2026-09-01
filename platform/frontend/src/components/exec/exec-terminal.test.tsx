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

import {
  type ExecSessionHandlers,
  type ExecSessionTransport,
  ExecTerminal,
} from "./exec-terminal";

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

  it("names the wait a session is in, and the runtime's reason for it", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onProgress?.({
          phase: "scheduling",
          message: "Waiting for a node with room for this run",
          detail: "Unschedulable: 0/3 nodes are available: insufficient cpu",
          resourceName: "archestra-run-abc123",
        });
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-2" transport={transport} isActive />);

    expect(
      await screen.findByText("Waiting for a node with room for this run"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Unschedulable: 0/3 nodes are available: insufficient cpu",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("archestra-run-abc123")).toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).not.toBeInTheDocument();
  });

  it("falls back to the plain connecting state for a transport that reports no progress", async () => {
    const transport: ExecSessionTransport = {
      open: () => vi.fn(),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-3" transport={transport} isActive />);

    expect(await screen.findByText("Connecting...")).toBeInTheDocument();
  });

  it("drops the startup progress once the session is live", async () => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        session.handlers = handlers;
        handlers.onProgress?.({
          phase: "attaching",
          message: "Opening the terminal stream",
          detail: null,
          resourceName: null,
        });
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-4" transport={transport} isActive />);
    await screen.findByText("Opening the terminal stream");

    session.handlers?.onStarted(null);

    await screen.findByText("Connected");
    expect(
      screen.queryByText("Opening the terminal stream"),
    ).not.toBeInTheDocument();
  });
});
