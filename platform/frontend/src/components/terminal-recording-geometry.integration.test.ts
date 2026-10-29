// @vitest-environment node
import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import {
  parseTerminalSize,
  prepareTerminalRecording,
} from "./terminal-recording-geometry";

test("a captured screen keeps the background tmux trimmed from its line ends", async () => {
  // Live output keeps its line ends as written; only the captured screen,
  // whose trailing spaces `tmux capture-pane -e` dropped, is restored.
  const live = "\x1b[48;5;235mlive\x1b[0m\x1b[48;5;235m\r\n\x1b[0m";
  // The trimmed spaces had the attribute in effect at each line's end: the
  // first line's set at its end, the second's carried from the first, the
  // third's reset.
  const capture =
    "\x1b[2J\x1b[H\x1b]777;archestra-terminal-size=8x4\x07" +
    "ab\x1b[48;5;235m\ncd\nef\x1b[0m\n";
  const recording = prepareTerminalRecording(live + capture);
  expect(recording.content.startsWith(live)).toBe(true);
  const terminal = new Terminal({ ...recording.dimensions, convertEol: true });
  try {
    await new Promise<void>((resolve) =>
      terminal.write(recording.content, resolve),
    );
    const buffer = terminal.buffer.active;
    const painted = (row: number) =>
      Array.from({ length: 8 }, (_, x) =>
        buffer.getLine(row)?.getCell(x)?.isBgDefault() ? "." : "#",
      ).join("");
    expect(buffer.getLine(0)?.translateToString(true)).toBe("ab");
    expect(painted(0)).toBe("..######");
    expect(painted(1)).toBe("########");
    expect(painted(2)).toBe("##......");
  } finally {
    terminal.dispose();
  }
});

test("replays legacy redraws through real xterm at each recovered grid", async () => {
  const redraw = (cols: number, rows: number, label: string) =>
    `\x1b[2J\x1b[H${label}\x1b[2;1H${"─".repeat(cols)}\x1b[${rows};1HBottom\x1b[1;${cols}HE`;
  const recording = prepareTerminalRecording(
    redraw(80, 23, "First") +
      redraw(66, 57, "Narrow") +
      redraw(208, 57, "Final story"),
  );
  const terminal = new Terminal(recording.dimensions);
  terminal.parser.registerOscHandler(777, (data) => {
    const size = parseTerminalSize(data);
    if (!size) return false;
    terminal.resize(size.cols, size.rows);
    return true;
  });
  try {
    const grids = [
      [80, 23],
      [66, 57],
      [208, 57],
    ];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: split at recorded terminal size events
    const frames = recording.content.split(/(?=\x1b\]777;)/);
    for (const [index, frame] of frames.entries()) {
      await new Promise<void>((resolve) => terminal.write(frame, resolve));
      const [cols, rows] = grids[index];
      expect([terminal.cols, terminal.rows]).toEqual([cols, rows]);
      const buffer = terminal.buffer.active;
      expect(
        buffer
          .getLine(buffer.baseY)
          ?.getCell(cols - 1)
          ?.getChars(),
      ).toBe("E");
      expect(
        buffer.getLine(buffer.baseY + rows - 1)?.translateToString(true),
      ).toBe("Bottom");
    }
  } finally {
    terminal.dispose();
  }
});
