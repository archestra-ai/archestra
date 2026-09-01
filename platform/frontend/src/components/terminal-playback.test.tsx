import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPlayback } from "./terminal-playback";

const { terminal, fit } = vi.hoisted(() => ({
  terminal: {
    dispose: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    reset: vi.fn(),
    write: vi.fn(),
  },
  fit: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class Terminal {
    dispose = terminal.dispose;
    loadAddon = terminal.loadAddon;
    open = terminal.open;
    reset = terminal.reset;
    write = terminal.write;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit = fit;
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

describe("TerminalPlayback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it("replays raw terminal controls and appends streamed bytes", async () => {
    const firstFrame = "\u001b[2J\u001b[2GClaude Code";
    const { rerender } = render(<TerminalPlayback content={firstFrame} />);

    await waitFor(() =>
      expect(terminal.write).toHaveBeenCalledWith(firstFrame),
    );

    await act(() =>
      rerender(<TerminalPlayback content={`${firstFrame}\r\nReady`} />),
    );
    expect(terminal.write).toHaveBeenLastCalledWith("\r\nReady");
    expect(terminal.reset).not.toHaveBeenCalled();
  });

  it("resets the emulated screen when the transcript is replaced", async () => {
    const { rerender } = render(<TerminalPlayback content="first task" />);
    await waitFor(() =>
      expect(terminal.write).toHaveBeenCalledWith("first task"),
    );

    await act(() => rerender(<TerminalPlayback content="replacement" />));
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenLastCalledWith("replacement");
  });
});
