import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import { indexTerminalRecording } from "./terminal-recording-index";

test("earlier full-screen output remains seekable after later frames erase it", async () => {
  const first = "\x1b[2J\x1b[HEarly work\r\nFirst result";
  const recording = `${first}\x1b[2J\x1b[HFinal answer`;
  const positions = indexTerminalRecording(recording);
  expect(positions).toContain(first.length);
  const terminal = new Terminal({ cols: 80, rows: 24 });
  try {
    await new Promise<void>((resolve) => terminal.write(recording, resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "Final answer",
    );
    terminal.reset();
    await new Promise<void>((resolve) =>
      terminal.write(recording.slice(0, first.length), resolve),
    );
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "Early work",
    );
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(
      "First result",
    );
  } finally {
    terminal.dispose();
  }
});

test("indexes all ordinary output and never splits OSC titles or synchronized frames", () => {
  const title = "\x1b]0;title\nwith a newline\x07";
  const frame = `${title}\x1b[?2026hUnicode 🦞\n\x1b[HSecond line\x1b[?2026l`;
  expect(indexTerminalRecording(frame)).toEqual([0, frame.length]);
  const lines = Array.from({ length: 100_000 }, (_, i) => `line ${i}\n`).join(
    "",
  );
  const positions = indexTerminalRecording(lines);
  expect(positions).toHaveLength(100_001);
  expect(lines.slice(0, positions[1])).toBe("line 0\n");
  expect(positions.at(-1)).toBe(lines.length);
});
