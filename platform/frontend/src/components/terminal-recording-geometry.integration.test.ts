// @vitest-environment node
import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import {
  parseTerminalSize,
  prepareTerminalRecording,
} from "./terminal-recording-geometry";

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
