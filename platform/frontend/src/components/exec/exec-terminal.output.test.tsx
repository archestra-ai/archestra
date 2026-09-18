import { act, render, screen } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminalHarness = vi.hoisted(() => ({
  terminal: null as Terminal | null,
}));

vi.mock("@xterm/xterm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xterm/xterm")>();
  return {
    ...actual,
    Terminal: class extends actual.Terminal {
      constructor(options: ConstructorParameters<typeof actual.Terminal>[0]) {
        super(options);
        terminalHarness.terminal = this;
      }
    },
  };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { type ExecSessionHandlers, ExecTerminal } from "./exec-terminal";

describe("ExecTerminal output", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }));
  });

  afterEach(() => {
    terminalHarness.terminal = null;
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "literal exit text and the output that follows it",
      chunks: ["done\r\n[exited]\r\nnext"],
      lines: ["done", "[exited]", "next"],
    },
    {
      name: "Unicode and ANSI sequences split across chunks",
      chunks: ["\u001b[3", "2m雪 \ud83d", "\ude80 [exited]", "\u001b[0m"],
      lines: ["雪 🚀 [exited]"],
    },
    {
      name: "an application's alternate-screen exit followed by literal exit text",
      chunks: ["main\r\n\u001b[?1049hTUI", "\u001b[?1049l[exited]\r\nafter"],
      lines: ["main", "[exited]", "after"],
    },
  ])("preserves $name through closure", async ({ chunks, lines }) => {
    const session: { handlers: ExecSessionHandlers | null } = {
      handlers: null,
    };
    render(
      <ExecTerminal
        sessionKey="output-session"
        isActive
        transport={{
          open(handlers) {
            session.handlers = handlers;
            handlers.onStarted(null);
            return () => {};
          },
          sendInput() {},
          sendResize() {},
        }}
      />,
    );
    await screen.findByText("Connected");

    await act(async () => {
      for (const chunk of chunks) session.handlers?.onOutput(chunk);
      session.handlers?.onClosed(null);
      await new Promise<void>((resolve) =>
        terminalHarness.terminal?.write("", resolve),
      );
    });

    expect(screen.getByText("Session terminated")).toBeInTheDocument();
    expect(
      lines.map((_, index) =>
        terminalHarness.terminal?.buffer.active
          .getLine(index)
          ?.translateToString(true),
      ),
    ).toEqual(lines);
  });
});
