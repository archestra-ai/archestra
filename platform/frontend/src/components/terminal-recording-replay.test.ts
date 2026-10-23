// @vitest-environment node
import { Terminal } from "@xterm/xterm";
import { expect, test } from "vitest";
import { prepareTerminalRecording } from "./terminal-recording-geometry";
import {
  createTerminalReplayer,
  splitTerminalRecording,
} from "./terminal-recording-replay";

const size = (cols: number, rows: number) =>
  `\x1b]777;archestra-terminal-size=${cols}x${rows}\x07`;

/** A full-screen client's redraw: every row written at its address. */
const draw = (label: string, cols: number, rows: number) =>
  `\x1b[1;1H\x1b[J${Array.from(
    { length: rows },
    (_, row) => `\x1b[${row + 1};1H${`${label} row ${row + 1}`.padEnd(cols)}`,
  ).join("")}\x1b[${rows - 3};7H`;

const rows = (terminal: Terminal) => {
  const buffer = terminal.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, y) => buffer.getLine(y)?.translateToString(true) ?? "",
  );
};

test("a redraw after the pane grew replaces the screens drawn before it", async () => {
  // The browser attaches at xterm's default size, then at its own: the client
  // redraws at 80x23 and again at 301x58, as Grok Build did in a run.
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 10_000 });
  try {
    await createTerminalReplayer(terminal).write(
      `${size(120, 40)}Everything up-to-date\r\n${"\n".repeat(40)}${draw("first", 120, 40)}${size(80, 23)}${draw("narrow", 80, 23)}${size(301, 58)}${draw("final", 301, 58)}`,
    );
    const lines = rows(terminal);
    expect([terminal.cols, terminal.rows]).toEqual([301, 58]);
    expect(lines).toHaveLength(58);
    expect(lines.filter((line) => line.startsWith("final row"))).toHaveLength(
      58,
    );
  } finally {
    terminal.dispose();
  }
});

test("a pane that grows takes plain output back from scrollback, as tmux does", async () => {
  const terminal = new Terminal({ cols: 40, rows: 4, scrollback: 10_000 });
  try {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
    await createTerminalReplayer(terminal).write(
      `${size(40, 4)}${output.join("\r\n")}\r\n${size(40, 10)}after the resize\r\n`,
    );
    const buffer = terminal.buffer.active;
    expect(buffer.baseY).toBe(0);
    expect(rows(terminal).slice(0, 9)).toEqual([...output, "after the resize"]);
    expect([buffer.cursorX, buffer.cursorY]).toEqual([0, 9]);
  } finally {
    terminal.dispose();
  }
});

test("keeps the output before the alternate screen and drops its rows a smaller pane cuts", async () => {
  // Claude Code enters the alternate screen; the browser attaches smaller.
  const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 10_000 });
  try {
    const output = Array.from({ length: 45 }, (_, i) => `clone ${i + 1}`);
    await createTerminalReplayer(terminal).write(
      `${size(120, 40)}${output.join("\r\n")}\r\n\x1b[?1049h\x1b[2J${draw("first", 120, 40)}${size(80, 23)}\x1b[2J${draw("narrow", 80, 23)}`,
    );
    const lines = rows(terminal);
    expect(lines.slice(0, 45)).toEqual(output);
    expect(lines.slice(45).map((line) => line.trimEnd())).toEqual(
      Array.from({ length: 23 }, (_, row) => `narrow row ${row + 1}`),
    );
    expect(terminal.buffer.active.baseY).toBe(45);
  } finally {
    terminal.dispose();
  }
});

test("holds back a sequence a live stream has not finished", async () => {
  const event = size(132, 50);
  const split = splitTerminalRecording(`output${event.slice(0, 20)}`);
  expect(split.frames).toEqual([{ bytes: "output" }]);
  expect(split.rest).toBe(event.slice(0, 20));
  expect(splitTerminalRecording("output\x1b[?10").rest).toBe("\x1b[?10");

  const terminal = new Terminal({ cols: 80, rows: 24 });
  try {
    const replayer = createTerminalReplayer(terminal);
    await replayer.write(`one\r\n${event.slice(0, 20)}`);
    expect([terminal.cols, terminal.rows]).toEqual([80, 24]);
    await replayer.write(event.slice(20));
    expect([terminal.cols, terminal.rows]).toEqual([132, 50]);
    expect(rows(terminal)[0]).toBe("one");
  } finally {
    terminal.dispose();
  }
  // Other escape sequences, and a size event xterm would ignore, are written.
  expect(splitTerminalRecording("text\x1b[31m").rest).toBe("");
  expect(splitTerminalRecording(`text${size(0, 5)}`)).toEqual({
    frames: [{ bytes: `text${size(0, 5)}` }],
    rest: "",
  });
});

test("leaves out the fenced answer a captured screen follows", () => {
  const capture = `\x1b[2J\x1b[H${size(80, 24)}the captured screen`;
  const answer =
    "\n===ARCHESTRA-FINAL-ANSWER===\nThe answer.\n===ARCHESTRA-FINAL-ANSWER-END===\n";
  expect(
    prepareTerminalRecording(`the live screen${answer}${capture}`).content,
  ).toBe(`the live screen${capture}`);
  // archestra-tui-run resets the terminal before the capture.
  const reset = "\x1b[?1000l\x1b[?6l\x1b[r\x1b[0m\x1b[2J\x1b[H";
  expect(
    prepareTerminalRecording(
      `the live screen${answer}${reset}${size(80, 24)}captured`,
    ).content,
  ).toBe(`the live screen${reset}${size(80, 24)}captured`);
  // A run without a terminal shows its answer in the recording.
  expect(prepareTerminalRecording(`output${answer}`).content).toBe(
    `output${answer}`,
  );
});
