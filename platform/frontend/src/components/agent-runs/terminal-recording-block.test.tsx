import { act, render, screen } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalRecordingBlock } from "./terminal-recording-block";
import { snapshotTerminalRecording } from "./terminal-recording-snapshot";

afterEach(() => vi.unstubAllGlobals());

test("keeps a measured placeholder when a wrapped block leaves the scroll viewport", async () => {
  let intersection: IntersectionObserverCallback | undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const terminal = new Terminal();
  await new Promise<void>((resolve) =>
    terminal.write("Long wrapped result", resolve),
  );
  const lines = snapshotTerminalRecording(terminal).lines.map((line) => ({
    ...line,
    runs: line.runs.map((run) => ({
      ...run,
      key: `${line.row}:${run.column}`,
    })),
  }));
  terminal.dispose();
  const { container } = render(
    <div data-testid="terminal-playback-viewport">
      <TerminalRecordingBlock lines={lines} wrapLines virtualize />
    </div>,
  );
  const block = container.querySelector(
    "[data-recording-block]",
  ) as HTMLElement;
  vi.spyOn(block, "getBoundingClientRect").mockReturnValue({
    width: 320,
    height: 144,
  } as DOMRect);
  expect(screen.queryByText("Long wrapped result")).not.toBeInTheDocument();
  await act(() =>
    intersection?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(screen.getByText("Long wrapped result")).toBeVisible();
  await act(() =>
    intersection?.(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  expect(screen.queryByText("Long wrapped result")).not.toBeInTheDocument();
  expect(block.style.height).toBe("144px");
});

test("an unmeasured placeholder reserves the measured row height", async () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const terminal = new Terminal();
  await new Promise<void>((resolve) =>
    terminal.write("one\r\ntwo\r\nthree", resolve),
  );
  const lines = snapshotTerminalRecording(terminal).lines.map((line) => ({
    ...line,
    runs: line.runs.map((run) => ({
      ...run,
      key: `${line.row}:${run.column}`,
    })),
  }));
  terminal.dispose();
  const { container } = render(
    <div data-testid="terminal-playback-viewport">
      <TerminalRecordingBlock
        lines={lines}
        wrapLines={false}
        cell={{ width: 7, height: 15 }}
        virtualize
      />
    </div>,
  );
  const block = container.querySelector(
    "[data-recording-block]",
  ) as HTMLElement;
  expect(screen.queryByText("one")).not.toBeInTheDocument();
  expect(block.style.height).toBe("45px");
});

test("reserves xterm's cell width for emoji and CJK in original layout", async () => {
  const terminal = new Terminal();
  await new Promise<void>((resolve) => terminal.write("A😀B界C", resolve));
  const lines = snapshotTerminalRecording(terminal).lines.map((line) => ({
    ...line,
    runs: line.runs.map((run) => ({
      ...run,
      key: `${line.row}:${run.column}`,
    })),
  }));
  terminal.dispose();
  const { rerender } = render(
    <TerminalRecordingBlock
      lines={lines}
      wrapLines={false}
      virtualize={false}
    />,
  );
  expect(screen.getByText("😀").style.width).toBe("1ch");
  expect(screen.getByText("界").style.width).toBe("2ch");
  rerender(
    <TerminalRecordingBlock lines={lines} wrapLines virtualize={false} />,
  );
  expect(screen.getByText("😀").style.width).toBe("");
});

test("a column starts at the same offset however its row is split into runs", async () => {
  const terminal = new Terminal();
  await new Promise<void>((resolve) =>
    terminal.write("Ran 2 cmds │\r\nRan \x1b[1m2\x1b[22m cmds │", resolve),
  );
  const lines = snapshotTerminalRecording(terminal).lines.map((line) => ({
    ...line,
    runs: line.runs.map((run) => ({
      ...run,
      key: `${line.row}:${run.column}`,
    })),
  }));
  terminal.dispose();
  const { container } = render(
    <TerminalRecordingBlock
      lines={lines}
      wrapLines={false}
      cell={{ width: 7.1875, height: 14 }}
      virtualize={false}
    />,
  );
  const offsets = [...container.querySelectorAll("[data-terminal-row]")].map(
    (row) => {
      const runs = [...row.children] as HTMLElement[];
      const divider = runs.findIndex((run) => run.textContent === "│");
      return runs
        .slice(0, divider)
        .reduce((sum, run) => sum + Number.parseFloat(run.style.width), 0);
    },
  );
  expect(lines[1].runs.length).toBeGreaterThan(lines[0].runs.length);
  expect(offsets).toEqual([11 * 7.1875, 11 * 7.1875]);
});

test("highlights and line-drawing characters fill their rows", async () => {
  const terminal = new Terminal();
  await new Promise<void>((resolve) =>
    terminal.write("\x1b[48;5;237m> prompt\x1b[0m \u2502", resolve),
  );
  const lines = snapshotTerminalRecording(terminal).lines.map((line) => ({
    ...line,
    runs: line.runs.map((run) => ({
      ...run,
      key: `${line.row}:${run.column}`,
    })),
  }));
  terminal.dispose();
  const { rerender } = render(
    <TerminalRecordingBlock
      lines={lines}
      wrapLines={false}
      virtualize={false}
    />,
  );
  const grid = screen.getByText("> prompt");
  expect(grid.style.display).toBe("inline-block");
  expect(grid.style.verticalAlign).toBe("top");
  // A divider drawn with box-drawing characters joins from row to row: the
  // glyph is stretched past its cell and clipped to it, so neighbours meet
  // without overlapping.
  const glyph = screen.getByText("\u2502");
  expect(glyph.style.transform).toBe("scale(1.1)");
  expect(glyph.parentElement?.style.overflow).toBe("hidden");
  rerender(
    <TerminalRecordingBlock lines={lines} wrapLines virtualize={false} />,
  );
  expect(screen.getByText("> prompt").style.display).toBe("");
});
