import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPlayback } from "./terminal-playback";

const { terminal, fit, dimensions, proposeDimensions } = vi.hoisted(() => {
  const dimensions = { current: { cols: 120, rows: 40 } };
  return {
    terminal: {
      dispose: vi.fn(),
      loadAddon: vi.fn(),
      open: vi.fn(),
      reset: vi.fn(),
      write: vi.fn(),
      options: [] as unknown[],
      registerCsiHandler: vi.fn(),
    },
    fit: vi.fn(),
    dimensions,
    proposeDimensions: vi.fn(() => dimensions.current),
  };
});

let resizeObserverCallback: ResizeObserverCallback | undefined;

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    constructor(options: unknown) {
      terminal.options.push(options);
    }
    dispose = terminal.dispose;
    loadAddon = terminal.loadAddon;
    open = terminal.open;
    reset = terminal.reset;
    write = terminal.write;
    parser = { registerCsiHandler: terminal.registerCsiHandler };
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = fit;
    proposeDimensions = proposeDimensions;
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

describe("TerminalPlayback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dimensions.current = { cols: 120, rows: 40 };
    resizeObserverCallback = undefined;
    terminal.options.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
  });

  it("waits to replay captured bytes until the panel has a usable grid", async () => {
    dimensions.current = { cols: 1, rows: 1 };
    render(<TerminalPlayback content="captured frame" />);

    await waitFor(() => expect(resizeObserverCallback).toBeDefined());
    expect(terminal.write).not.toHaveBeenCalled();

    dimensions.current = { cols: 120, rows: 40 };
    act(() => resizeObserverCallback?.([], {} as unknown as ResizeObserver));

    expect(terminal.write).toHaveBeenCalledWith(
      `captured frame${readOnlyTerminalState}`,
    );
  });

  it("replays raw terminal controls and appends streamed bytes", async () => {
    const firstFrame = "\u001b[2J\u001b[2GClaude Code";
    const { rerender } = render(<TerminalPlayback content={firstFrame} />);

    await waitFor(() =>
      expect(terminal.write).toHaveBeenCalledWith(
        `${firstFrame}${readOnlyTerminalState}`,
      ),
    );

    await act(() =>
      rerender(<TerminalPlayback content={`${firstFrame}\r\nReady`} />),
    );
    expect(terminal.write).toHaveBeenLastCalledWith(
      `\r\nReady${readOnlyTerminalState}`,
    );
    expect(terminal.reset).not.toHaveBeenCalled();
  });

  it("resets the emulated screen when the transcript is replaced", async () => {
    const { rerender } = render(<TerminalPlayback content="first task" />);
    await waitFor(() =>
      expect(terminal.write).toHaveBeenCalledWith(
        `first task${readOnlyTerminalState}`,
      ),
    );

    await act(() => rerender(<TerminalPlayback content="replacement" />));
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenLastCalledWith(
      `replacement${readOnlyTerminalState}`,
    );
  });

  it("replays the retained frame when its grid dimensions change", async () => {
    render(<TerminalPlayback content="captured frame" />);
    await waitFor(() => expect(terminal.write).toHaveBeenCalledOnce());

    dimensions.current = { cols: 90, rows: 30 };
    act(() => resizeObserverCallback?.([], {} as unknown as ResizeObserver));

    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenLastCalledWith(
      `captured frame${readOnlyTerminalState}`,
    );
  });

  it("keeps retained playback locally scrollable", async () => {
    render(<TerminalPlayback content="captured frame" />);
    await waitFor(() => expect(terminal.write).toHaveBeenCalledOnce());

    expect(terminal.options.at(-1)).toMatchObject({
      convertEol: true,
      disableStdin: true,
      scrollback: 50_000,
      scrollSensitivity: 3,
    });
    expect(terminal.write).toHaveBeenCalledWith(
      expect.stringContaining("\u001b[?1003l"),
    );

    const setModeHandler = terminal.registerCsiHandler.mock.calls.find(
      ([identifier]) => identifier.final === "h",
    )?.[1];
    const resetModeHandler = terminal.registerCsiHandler.mock.calls.find(
      ([identifier]) => identifier.final === "l",
    )?.[1];

    expect(setModeHandler?.([1049])).toBe(true);
    expect(resetModeHandler?.([47])).toBe(true);
    expect(setModeHandler?.([25])).toBe(false);
  });
});

const readOnlyTerminalState =
  "\u001b[?25l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?1015l";
