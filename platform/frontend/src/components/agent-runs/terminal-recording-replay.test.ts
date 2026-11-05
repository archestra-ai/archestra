// @vitest-environment node
import { Terminal } from "@xterm/xterm";
import { expect, test, vi } from "vitest";
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

test("keeps the cursor on its line when the pane also changes width", async () => {
  // A wider pane unwraps a long line above the cursor; the cursor follows it.
  const terminal = new Terminal({ cols: 40, rows: 4, scrollback: 10_000 });
  try {
    const long = "x".repeat(70);
    const output = ["line 1", "line 2", long, "line 4", "line 5", "line 6"];
    await createTerminalReplayer(terminal).write(
      `${size(40, 4)}${output.join("\r\n")}\r\n${size(100, 8)}after\r\n`,
    );
    const buffer = terminal.buffer.active;
    expect(buffer.baseY).toBe(0);
    expect(rows(terminal).slice(0, 7)).toEqual([...output, "after"]);
    expect([buffer.cursorX, buffer.cursorY]).toEqual([0, 7]);
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

test("writes frames together across size events that keep the pane's size", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  const resize = vi.spyOn(terminal, "resize");
  const write = vi.spyOn(terminal, "write");
  try {
    await createTerminalReplayer(terminal).write(
      `${size(80, 24)}one\r\n${size(80, 24)}\x1b[2J\x1b[Htwo\r\n${size(80, 24)}three\r\n`,
    );
    expect(resize).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(rows(terminal).slice(0, 2)).toEqual(["two", "three"]);
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
  // A size event ended by a string terminator, cut inside the terminator.
  const terminated = "\x1b]777;archestra-terminal-size=132x50\x1b\\";
  expect(splitTerminalRecording(`output${terminated.slice(0, -1)}`).rest).toBe(
    terminated.slice(0, -1),
  );

  const terminal = new Terminal({ cols: 80, rows: 24 });
  try {
    const replayer = createTerminalReplayer(terminal);
    await replayer.write(`one\r\n${event.slice(0, 20)}`);
    expect([terminal.cols, terminal.rows]).toEqual([80, 24]);
    await replayer.write(event.slice(20));
    expect([terminal.cols, terminal.rows]).toEqual([132, 50]);
    await replayer.write(terminated.slice(0, -1).replace("132x50", "100x30"));
    expect([terminal.cols, terminal.rows]).toEqual([132, 50]);
    await replayer.write("\\");
    expect([terminal.cols, terminal.rows]).toEqual([100, 30]);
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

test("writes nothing more once stopped", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  try {
    const replayer = createTerminalReplayer(terminal);
    replayer.stop();
    await replayer.write(`one\r\n${size(100, 30)}two\r\n`);
    expect([terminal.cols, terminal.rows]).toEqual([80, 24]);
    expect(rows(terminal)[0]).toBe("");
  } finally {
    terminal.dispose();
  }
});

test("leaves out the fenced answer a captured screen follows", () => {
  const fence = (answer: string) =>
    `\n===ARCHESTRA-FINAL-ANSWER===\n${answer}\n===ARCHESTRA-FINAL-ANSWER-END===\n`;
  const capture = `\x1b[2J\x1b[H${size(80, 24)}the captured screen`;
  expect(
    prepareTerminalRecording(`the live screen${fence("The answer.")}${capture}`)
      .content,
  ).toBe(`the live screen${capture}`);
  // archestra-tui-run resets the terminal before the capture, and leaves
  // out the size event when tmux did not report one.
  const reset = "\x1b[?1000l\x1b[?6l\x1b[r\x1b[0m\x1b[2J\x1b[H";
  expect(
    prepareTerminalRecording(
      `the live screen${fence("The answer.")}${reset}captured`,
    ).content,
  ).toBe(`the live screen${reset}captured`);
  // The last fence is the answer's: a client can scroll an earlier one into
  // view, and its rows stay.
  const scrolled = "\n===ARCHESTRA-FINAL-ANSWER===\nrows of the screen\n";
  expect(
    prepareTerminalRecording(
      `the live screen${scrolled}${fence("The answer.")}${capture}`,
    ).content,
  ).toBe(`the live screen${scrolled}${capture}`);
  // A run without a terminal shows its answer in the recording.
  expect(
    prepareTerminalRecording(`output${fence("The answer.")}`).content,
  ).toBe(`output${fence("The answer.")}`);
});

test("takes lines back under origin mode and a scroll region, as tmux does", async () => {
  const terminal = new Terminal({ cols: 20, rows: 5, scrollback: 10_000 });
  try {
    const output = ["one", "two", "three", "four", "five", "six"];
    await createTerminalReplayer(terminal).write(
      `${size(20, 5)}${output.join("\r\n")}\r\n\x1b[2;4r\x1b[?6h\x1b[1;1H${size(20, 8)}NEXT`,
    );
    const buffer = terminal.buffer.active;
    expect(buffer.baseY).toBe(0);
    expect(rows(terminal).slice(0, 6)).toEqual([
      "one",
      "two",
      "three",
      "NEXT",
      "five",
      "six",
    ]);
    expect(terminal.modes.originMode).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("cuts the alternate screen's top rows under origin mode and a scroll region", async () => {
  const terminal = new Terminal({ cols: 20, rows: 8, scrollback: 10_000 });
  try {
    const screen = Array.from(
      { length: 8 },
      (_, row) => `\x1b[${row + 1};1Halt row ${row + 1}`,
    ).join("");
    await createTerminalReplayer(terminal).write(
      `${size(20, 8)}\x1b[?1049h${screen}\x1b[2;7r\x1b[?6h\x1b[6;1H${size(20, 5)}X`,
    );
    expect(rows(terminal).map((line) => line.trimEnd())).toEqual([
      "alt row 3",
      "alt row 4",
      "alt row 5",
      "alt row 6",
      "Xlt row 7",
    ]);
    expect(terminal.buffer.active.baseY).toBe(0);
  } finally {
    terminal.dispose();
  }
});

test("keeps the client's scroll region when it enters the alternate screen", async () => {
  // No resize happens on entry, so the region the client set stays, as in
  // tmux: its origin-relative addresses keep meaning the same rows.
  const terminal = new Terminal({ cols: 20, rows: 5, scrollback: 10_000 });
  try {
    await createTerminalReplayer(terminal).write(
      `${size(20, 5)}before\r\n\x1b[2;4r\x1b[?6h\x1b[1;1H\x1b[?1049h\x1b[2J\x1b[1;1HALT`,
    );
    const buffer = terminal.buffer.active;
    expect(buffer.baseY).toBe(1);
    expect(rows(terminal).slice(0, 3)).toEqual(["before", "", "ALT"]);
    expect(terminal.modes.originMode).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("a reset the client sends opens its scroll region", async () => {
  // RIS resets the margins, so entering the alternate screen afterwards
  // restores none: `ALT` lands on the first row, as in tmux.
  const terminal = new Terminal({ cols: 20, rows: 5, scrollback: 10_000 });
  try {
    await createTerminalReplayer(terminal).write(
      `${size(20, 5)}before\r\n\x1b[2;4r\x1bc\x1b[?6h\x1b[?1049h\x1b[2J\x1b[1;1HALT`,
    );
    expect(rows(terminal)).toEqual(["ALT", "", "", "", ""]);
    expect(terminal.buffer.active.baseY).toBe(0);
    expect(terminal.modes.originMode).toBe(true);
  } finally {
    terminal.dispose();
  }
});

test("a soft reset the client sends changes nothing, as in tmux", async () => {
  // tmux has no DECSTR, so the region and origin mode stay and `ALT` lands
  // on the second row, as without the reset.
  const terminal = new Terminal({ cols: 20, rows: 5, scrollback: 10_000 });
  try {
    await createTerminalReplayer(terminal).write(
      `${size(20, 5)}before\r\n\x1b[2;4r\x1b[!p\x1b[?6h\x1b[?1049h\x1b[2J\x1b[1;1HALT`,
    );
    expect(terminal.buffer.active.baseY).toBe(1);
    expect(rows(terminal).slice(0, 3)).toEqual(["before", "", "ALT"]);
    expect(terminal.modes.originMode).toBe(true);
  } finally {
    terminal.dispose();
  }
});
