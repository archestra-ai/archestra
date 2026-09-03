import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => {
  return {
    write: vi.fn(),
    dataHandler: null as ((data: string) => void) | null,
    resizeHandler: null as
      | ((dimensions: { cols: number; rows: number }) => void)
      | null,
    resizeObserverCallback: null as ResizeObserverCallback | null,
    proposedDimensions: { cols: 80, rows: 24 },
    emitData(data: string) {
      this.dataHandler?.(data);
    },
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
    write = terminalHarness.write;
    onData(handler: (data: string) => void) {
      terminalHarness.dataHandler = handler;
    }
    onResize(handler: (dimensions: { cols: number; rows: number }) => void) {
      terminalHarness.resizeHandler = handler;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => terminalHarness.proposedDimensions);
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import {
  type ExecSessionHandlers,
  type ExecSessionTransport,
  ExecTerminal,
} from "./exec-terminal";

global.ResizeObserver = class ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    terminalHarness.resizeObserverCallback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe("ExecTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    terminalHarness.dataHandler = null;
    terminalHarness.resizeHandler = null;
    terminalHarness.resizeObserverCallback = null;
    terminalHarness.proposedDimensions = { cols: 80, rows: 24 };
    terminalHarness.write.mockReset();
  });

  it("waits for a usable terminal grid before opening the remote session", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    terminalHarness.proposedDimensions = { cols: 1, rows: 1 };
    const transport: ExecSessionTransport = {
      open: vi.fn(() => vi.fn()),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal sessionKey="task-layout" transport={transport} isActive />,
    );

    await waitFor(() =>
      expect(terminalHarness.resizeObserverCallback).not.toBeNull(),
    );
    expect(transport.open).not.toHaveBeenCalled();

    terminalHarness.proposedDimensions = { cols: 120, rows: 40 };
    act(() =>
      terminalHarness.resizeObserverCallback?.(
        [],
        {} as unknown as ResizeObserver,
      ),
    );

    await waitFor(() => expect(transport.open).toHaveBeenCalledOnce());
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

  /**
   * The startup phase is conveyed by a spinner moving down a list, which a
   * screen reader user cannot see. The phase text has to be announced instead.
   */
  it("announces the current wait to assistive technology", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onProgress?.({
          phase: "pulling",
          message: "Pulling the agent image",
          detail: null,
          resourceName: null,
        });
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-5" transport={transport} isActive />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Pulling the agent image",
    );
  });

  /**
   * The step spinner is the only animation on the panel, so it is the one that
   * has to hold still for readers who ask motion to stop (WCAG 2.3.3).
   */
  it("keeps the step spinner still under prefers-reduced-motion", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onProgress?.({
          phase: "starting",
          message: "Waiting for the agent session",
          detail: null,
          resourceName: null,
        });
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    const { container } = render(
      <ExecTerminal sessionKey="task-6" transport={transport} isActive />,
    );
    await screen.findByText("Waiting for the agent session");

    expect(
      container.querySelector(".animate-spin.motion-reduce\\:animate-none"),
    ).toBeInTheDocument();
  });

  it("falls back to the plain connecting state for a transport that reports no progress", async () => {
    const transport: ExecSessionTransport = {
      open: () => vi.fn(),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(<ExecTerminal sessionKey="task-3" transport={transport} isActive />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connecting to the terminal",
    );
  });

  it("explains a failed attach as an accessible terminal error", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onError(
          "Timed out waiting for the Agent pod to accept a terminal",
        );
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal sessionKey="task-error" transport={transport} isActive />,
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Unable to open the terminal")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Timed out waiting for the Agent pod to accept a terminal",
      ),
    ).toBeInTheDocument();
  });

  it("separates a closed session's summary from its reason", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onClosed("The pod stopped responding");
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal
        sessionKey="task-closed"
        transport={transport}
        isActive
        disconnectedLabel="Execution finished"
      />,
    );

    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Execution finished")).toBeInTheDocument();
    expect(screen.getByText("The pod stopped responding")).toBeInTheDocument();
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

  it("drops no-button mouse motion without swallowing terminal input", async () => {
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

    terminalHarness.emitData("\x1b[<35;3;18M\x1b[<39;4;18M\x1b[<63;5;18M");
    terminalHarness.emitData("git status\r");
    terminalHarness.emitData("\x1b[<0;8;12M\x1b[<32;9;12M");

    expect(transport.sendInput).toHaveBeenNthCalledWith(1, "git status\r");
    expect(transport.sendInput).toHaveBeenNthCalledWith(
      2,
      "\x1b[<0;8;12M\x1b[<32;9;12M",
    );
    expect(transport.sendInput).toHaveBeenCalledTimes(2);
  });

  it("accelerates remote wheel scrolling without changing keyboard input", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal sessionKey="task-wheel" transport={transport} isActive />,
    );
    await screen.findByText("Connected");

    terminalHarness.emitData("\x1b[<64;5;18M");
    terminalHarness.emitData("j");

    expect(transport.sendInput).toHaveBeenNthCalledWith(
      1,
      "\x1b[<64;5;18M".repeat(3),
    );
    expect(transport.sendInput).toHaveBeenNthCalledWith(2, "j");
  });

  it("does not render tmux's exit notice into the completed frame", async () => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        session.handlers = handlers;
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal sessionKey="task-exit" transport={transport} isActive />,
    );
    await screen.findByText("Connected");

    act(() => session.handlers?.onOutput("done\r\n[exited]\r\n"));

    expect(terminalHarness.write).toHaveBeenCalledWith("done");
  });

  it("keeps the last TUI frame when tmux exits its alternate screen", async () => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        session.handlers = handlers;
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal sessionKey="task-exit" transport={transport} isActive />,
    );
    await screen.findByText("Connected");

    act(() => session.handlers?.onOutput("\u001b[?1049l\r\n[exited]\r\n"));

    expect(terminalHarness.write).not.toHaveBeenCalled();
  });

  it("can retain the terminal frame without adding a disconnected banner", async () => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        session.handlers = handlers;
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal
        sessionKey="task-1"
        transport={transport}
        isActive
        disconnectedLabel="Execution finishing…"
        showDisconnectedStatus={false}
      />,
    );
    await screen.findByText("Connected");

    act(() => session.handlers?.onClosed(null));

    expect(screen.queryByText("Execution finishing…")).not.toBeInTheDocument();
  });

  it("can expose the manual command without rendering it inline", async () => {
    const onCommandChange = vi.fn();
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted("kubectl exec example");
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal
        sessionKey="task-1"
        transport={transport}
        isActive
        showManualCommand={false}
        onCommandChange={onCommandChange}
      />,
    );

    await screen.findByText("Connected");
    expect(onCommandChange).toHaveBeenCalledWith("kubectl exec example");
    expect(screen.queryByText("Manual Command")).not.toBeInTheDocument();
    expect(screen.queryByText("kubectl exec example")).not.toBeInTheDocument();
  });
});
