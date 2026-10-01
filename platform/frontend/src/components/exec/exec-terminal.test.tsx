import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => {
  return {
    write: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    clearSelection: vi.fn(),
    keyHandler: null as ((event: KeyboardEvent) => boolean) | null,
    oscHandler: null as ((data: string) => boolean) | null,
    selectedText: "",
    copyToClipboard: vi.fn().mockResolvedValue(undefined),
    element: null as HTMLDivElement | null,
    textarea: null as HTMLTextAreaElement | null,
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
    options: { disableStdin?: boolean };
    textarea = document.createElement("textarea");
    constructor(options: { disableStdin?: boolean }) {
      this.options = options;
    }
    loadAddon() {}
    open(element: HTMLDivElement) {
      terminalHarness.element = element;
      terminalHarness.textarea = this.textarea;
      element.appendChild(this.textarea);
      element.addEventListener("mousedown", () => this.focus());
    }
    dispose() {}
    focus() {
      terminalHarness.focus();
      this.textarea.focus();
    }
    blur() {
      terminalHarness.blur();
      this.textarea.blur();
    }
    clearSelection = terminalHarness.clearSelection;
    hasSelection = () => !!terminalHarness.selectedText;
    getSelection = () => terminalHarness.selectedText;
    parser = {
      registerOscHandler: (
        identifier: number,
        handler: (data: string) => boolean,
      ) => {
        expect(identifier).toBe(52);
        terminalHarness.oscHandler = handler;
        return { dispose: vi.fn() };
      },
    };
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      terminalHarness.keyHandler = handler;
    }
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
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: terminalHarness.copyToClipboard,
}));

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
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    terminalHarness.dataHandler = null;
    terminalHarness.resizeHandler = null;
    terminalHarness.resizeObserverCallback = null;
    terminalHarness.proposedDimensions = { cols: 80, rows: 24 };
    terminalHarness.write.mockReset();
    terminalHarness.keyHandler = null;
    terminalHarness.oscHandler = null;
    terminalHarness.selectedText = "";
    terminalHarness.copyToClipboard.mockResolvedValue(undefined);
    terminalHarness.element = null;
    terminalHarness.textarea = null;
  });

  it("routes input to the terminal by default and suppresses only its native context menu", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    render(
      <ExecTerminal
        sessionKey="focus-default"
        transport={transport}
        isActive
      />,
    );
    await screen.findByText("Connected");
    const toggle = screen.getByRole("button", { name: "Focus terminal" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const terminal = terminalHarness.element;
    const target = terminalHarness.textarea;
    if (!terminal || !target) throw new Error("Terminal did not initialize");
    const mouse = vi.fn(() => terminalHarness.emitData("\x1b[<2;8;12M"));
    const mouseUp = vi.fn(() => terminalHarness.emitData("\x1b[<2;8;12m"));
    const emulatorContextMenu = vi.fn();
    target.addEventListener("mousedown", mouse);
    target.addEventListener("mouseup", mouseUp);
    target.addEventListener("contextmenu", emulatorContextMenu);
    fireEvent.mouseDown(target, { button: 2 });
    expect(mouse).toHaveBeenCalledOnce();
    expect(transport.sendInput).toHaveBeenCalledWith("\x1b[<2;8;12M");
    fireEvent.mouseUp(target, { button: 2 });
    expect(mouseUp).toHaveBeenCalledOnce();
    expect(transport.sendInput).toHaveBeenCalledWith("\x1b[<2;8;12m");
    expect(fireEvent.contextMenu(target)).toBe(false);
    expect(emulatorContextMenu).toHaveBeenCalledOnce();
    expect(emulatorContextMenu.mock.calls[0][0].defaultPrevented).toBe(true);
    expect(target).toHaveFocus();
    const emulatorKey = vi.fn();
    const appShortcut = vi.fn();
    target.addEventListener("keydown", emulatorKey);
    document.addEventListener("keydown", appShortcut);
    fireEvent.keyDown(target, { key: "b", ctrlKey: true });
    expect(emulatorKey).toHaveBeenCalledOnce();
    expect(appShortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(toggle, { key: "b", ctrlKey: true });
    expect(appShortcut).toHaveBeenCalledOnce();
    document.removeEventListener("keydown", appShortcut);
    expect(
      terminalHarness.keyHandler?.(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
      ),
    ).toBe(true);
    terminalHarness.emitData("\x03");
    expect(transport.sendInput).toHaveBeenCalledWith("\x03");
    // Header controls keep their normal context menu in either mode.
    expect(fireEvent.contextMenu(toggle)).toBe(true);
    expect(terminal.contains(toggle)).toBe(false);
  });

  it("restores browser defaults and blocks mouse, keyboard, paste and pending input when off", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    render(
      <ExecTerminal
        sessionKey="focus-browser"
        transport={transport}
        isActive
      />,
    );
    await screen.findByText("Connected");
    const target = terminalHarness.textarea;
    if (!target) throw new Error("Terminal did not initialize");
    const xtermEvent = vi.fn((event: Event) => {
      event.preventDefault();
      terminalHarness.emitData("terminal input");
    });
    for (const name of [
      "mousedown",
      "mousemove",
      "mouseup",
      "wheel",
      "keydown",
      "keyup",
      "copy",
      "paste",
      "contextmenu",
    ]) {
      target.addEventListener(name, xtermEvent);
    }
    target.focus();
    fireEvent.click(screen.getByRole("button", { name: "Focus terminal" }));
    expect(target).toBeDisabled();
    expect(target).not.toHaveFocus();
    expect(terminalHarness.blur).toHaveBeenCalledOnce();
    expect(
      terminalHarness.keyHandler?.(
        new KeyboardEvent("keydown", { key: "a", metaKey: true }),
      ),
    ).toBe(false);
    for (const name of [
      "mousedown",
      "mousemove",
      "mouseup",
      "wheel",
      "keydown",
      "keyup",
      "copy",
      "paste",
      "contextmenu",
    ]) {
      expect(
        fireEvent(target, new Event(name, { bubbles: true, cancelable: true })),
      ).toBe(true);
    }
    terminalHarness.emitData("pending paste\r\x1b[<2;8;12M");
    expect(xtermEvent).not.toHaveBeenCalled();
    expect(transport.sendInput).not.toHaveBeenCalled();
  });

  it("blurs on either mode change and only focuses on a terminal click, including repeated and hidden tab transitions", async () => {
    const transport: ExecSessionTransport = {
      open: vi.fn((handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      }),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    const { rerender } = render(
      <ExecTerminal
        sessionKey="focus-transitions"
        transport={transport}
        isActive
      />,
    );
    await screen.findByText("Connected");
    const toggle = screen.getByRole("button", { name: "Focus terminal" });
    for (let i = 0; i < 3; i++) {
      const target = terminalHarness.textarea;
      if (!target) throw new Error("Terminal did not initialize");
      fireEvent.mouseDown(target);
      expect(target).toHaveFocus();
      fireEvent.click(toggle);
      expect(target).not.toHaveFocus();
      fireEvent.mouseDown(target);
      expect(target).not.toHaveFocus();
      terminalHarness.emitData("ignored");
      fireEvent.click(toggle);
      expect(target).not.toHaveFocus();
      expect(terminalHarness.textarea).not.toBeDisabled();
      fireEvent.mouseDown(target);
      expect(target).toHaveFocus();
      terminalHarness.emitData("accepted");
    }
    expect(transport.open).toHaveBeenCalledOnce();
    expect(transport.sendInput).toHaveBeenCalledTimes(3);
    fireEvent.click(toggle);
    rerender(
      <ExecTerminal
        sessionKey="focus-transitions"
        transport={transport}
        isActive={false}
      />,
    );
    rerender(
      <ExecTerminal
        sessionKey="focus-transitions"
        transport={transport}
        isActive
      />,
    );
    await waitFor(() => expect(transport.open).toHaveBeenCalledTimes(2));
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(terminalHarness.textarea).toBeDisabled();
    terminalHarness.emitData("still ignored");
    expect(transport.sendInput).toHaveBeenCalledTimes(3);
    fireEvent.click(toggle);
    expect(terminalHarness.textarea).not.toHaveFocus();
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

  it("keeps persisted startup progress and elapsed time across page loads", async () => {
    const startedAt = Date.now() - 122_000;
    const transport: ExecSessionTransport = {
      open: () => vi.fn(),
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };

    render(
      <ExecTerminal
        sessionKey="task-persisted-progress"
        transport={transport}
        isActive
        initialProgress={{
          phase: "scheduling",
          message: "Waiting for a node with room for this run",
          detail: "No eligible node is currently available",
          resourceName: "agent-run-example",
        }}
        progressStartedAt={startedAt}
      />,
    );

    expect(
      await screen.findByText("Waiting for a node with room for this run"),
    ).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("2:02");
    expect(
      screen.getByText("No eligible node is currently available"),
    ).toBeInTheDocument();
  });

  it("prefers live startup progress over a stale persisted snapshot", async () => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        session.handlers = handlers;
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    const initialProgress = {
      phase: "scheduling" as const,
      message: "Waiting for a node",
      detail: null,
      resourceName: null,
    };
    const { rerender } = render(
      <ExecTerminal
        sessionKey="task-live-progress"
        transport={transport}
        isActive
        initialProgress={initialProgress}
      />,
    );
    await screen.findByText("Waiting for a node");

    act(() =>
      session.handlers?.onProgress?.({
        phase: "pulling",
        message: "Pulling the agent image",
        detail: null,
        resourceName: "agent-run-example",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Pulling the agent image",
      ),
    );

    rerender(
      <ExecTerminal
        sessionKey="task-live-progress"
        transport={transport}
        isActive
        initialProgress={{ ...initialProgress }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Pulling the agent image",
    );
    expect(screen.queryByText("Waiting for a node")).not.toBeInTheDocument();
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

  it("types the stored paths of files dropped on a live terminal", async () => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        session.handlers = handlers;
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    const onDropFiles = vi
      .fn()
      .mockResolvedValue(["/runtime/a/shot.png", "/runtime/b/notes.txt"]);
    const files = [
      new File(["png"], "shot.png", { type: "image/png" }),
      new File(["txt"], "notes.txt", { type: "text/plain" }),
    ];

    render(
      <ExecTerminal
        sessionKey="task-drop"
        transport={transport}
        isActive
        onDropFiles={onDropFiles}
      />,
    );
    await waitFor(() => expect(session.handlers).not.toBeNull());
    session.handlers?.onStarted(null);
    await screen.findByText("Connected");

    fireEvent.drop(terminalHarness.element as HTMLDivElement, {
      dataTransfer: { files, types: ["Files"] },
    });

    await waitFor(() =>
      expect(transport.sendInput).toHaveBeenCalledWith(
        "/runtime/a/shot.png /runtime/b/notes.txt ",
      ),
    );
    expect(onDropFiles).toHaveBeenCalledWith(files);
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

    render(
      <ExecTerminal
        sessionKey="task-1"
        transport={transport}
        isActive
        claudeMouseWorkaround
      />,
    );

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
      <ExecTerminal
        sessionKey="task-wheel"
        transport={transport}
        isActive
        claudeMouseWorkaround
      />,
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

  it("preserves native TUI hover, drag, release and wheel reports across focus switches", async () => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    render(
      <ExecTerminal sessionKey="native-tui" transport={transport} isActive />,
    );
    await screen.findByText("Connected");
    const reports =
      "\x1b[<35;3;18M\x1b[<0;3;18M\x1b[<32;8;18M\x1b[<0;8;18m\x1b[<64;8;18M";
    terminalHarness.emitData(reports);
    expect(transport.sendInput).toHaveBeenLastCalledWith(reports);
    fireEvent.click(screen.getByRole("button", { name: /Focus terminal/ }));
    terminalHarness.emitData(reports);
    expect(transport.sendInput).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Focus terminal/ }));
    terminalHarness.emitData(reports);
    expect(transport.sendInput).toHaveBeenCalledTimes(2);
    expect(transport.sendInput).toHaveBeenLastCalledWith(reports);
  });

  it("copies native TUI OSC 52 text to the host clipboard only in active terminal mode", async () => {
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    render(
      <ExecTerminal sessionKey="native-copy" transport={transport} isActive />,
    );
    await screen.findByText("Connected");
    const report = `c;${btoa(String.fromCharCode(...new TextEncoder().encode("Copied ✓\nNext line")))}`;
    terminalHarness.oscHandler?.(report);
    expect(terminalHarness.copyToClipboard).toHaveBeenCalledWith(
      "Copied ✓\nNext line",
    );
    terminalHarness.oscHandler?.("c;?");
    terminalHarness.oscHandler?.("c;not base64!");
    terminalHarness.oscHandler?.("missing separator");
    expect(terminalHarness.copyToClipboard).toHaveBeenCalledTimes(1);
    focused.mockReturnValue(false);
    terminalHarness.oscHandler?.(report);
    focused.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Focus terminal/ }));
    terminalHarness.oscHandler?.(report);
    expect(terminalHarness.copyToClipboard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Focus terminal/ }));
    terminalHarness.oscHandler?.(report);
    expect(terminalHarness.copyToClipboard).toHaveBeenCalledTimes(2);
    expect(transport.sendInput).not.toHaveBeenCalled();
  });

  it.each([
    "metaKey",
    "ctrlKey",
  ] as const)("copies xterm selection with %s+C while retaining unselected terminal shortcuts", async (modifier) => {
    const transport: ExecSessionTransport = {
      open: (handlers) => {
        handlers.onStarted(null);
        return vi.fn();
      },
      sendInput: vi.fn(),
      sendResize: vi.fn(),
    };
    render(
      <ExecTerminal
        sessionKey="keyboard-copy"
        transport={transport}
        isActive
      />,
    );
    await screen.findByText("Connected");
    const event = () =>
      new KeyboardEvent("keydown", {
        key: "c",
        [modifier]: true,
        cancelable: true,
      });
    expect(terminalHarness.keyHandler?.(event())).toBe(true);
    terminalHarness.selectedText = "Selected terminal text";
    const copy = event();
    expect(terminalHarness.keyHandler?.(copy)).toBe(false);
    expect(copy.defaultPrevented).toBe(true);
    expect(terminalHarness.copyToClipboard).toHaveBeenCalledWith(
      "Selected terminal text",
    );
    expect(transport.sendInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Focus terminal/ }));
    terminalHarness.keyHandler?.(event());
    expect(terminalHarness.copyToClipboard).toHaveBeenCalledTimes(1);
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
