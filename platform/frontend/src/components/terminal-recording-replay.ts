import type { Terminal } from "@xterm/xterm";
import {
  parseTerminalSize,
  type TerminalDimensions,
} from "./terminal-recording-geometry";

/**
 * Writes a recording to xterm as the recorded pane received it.
 *
 * The recorder puts a size event in the stream when the pane resized, before
 * the client's redraw at the new size, so the terminal resizes between two
 * writes, and as tmux resized the pane: a pane that grows takes lines back
 * from its history before it adds blank rows. xterm takes lines back only
 * while the cursor is on the last row, so without this a full-screen
 * client's redraw after the browser attached (at 80x24, then at its real
 * size) landed below the screens drawn before, and those stayed in the
 * document as stale frames.
 *
 * The alternate screen is replayed in the normal buffer, so the document
 * keeps the output before it and the client's last screen after it. On
 * entry, the rows written so far scroll into the document rather than being
 * erased by the client's first clear. While the alternate screen is on, a
 * pane that shrinks drops its top rows and a pane that grows takes nothing
 * back, as tmux's alternate screen has no history.
 *
 * The cursor moves the replayer makes assume the scroll region covers the
 * screen and origin mode is off, as clients leave them between turns. With
 * a region set, a line feed on the last row and a line deletion at the top
 * do nothing, and the screen is cleared or scrolled as it was before.
 */
export function createTerminalReplayer(terminal: Terminal): TerminalReplayer {
  let alternate = false;
  let stopped = false;
  /** Bytes a live stream ended with that do not finish a sequence yet. */
  let unfinished = "";
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (!alternateScreenMode(params.filter(isNumber))) return false;
    alternate = true;
    return true;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (!alternateScreenMode(params.filter(isNumber))) return false;
    alternate = false;
    return true;
  });
  return {
    async write(content) {
      const { frames, rest } = splitTerminalRecording(unfinished + content);
      unfinished = rest;
      // Frames are written together until one changes the terminal: a size
      // event for the size the terminal has is free, as legacy recordings
      // carry one before every clear.
      let pending = "";
      for (const frame of frames) {
        const resizes =
          frame.size !== undefined &&
          (frame.size.cols !== terminal.cols ||
            frame.size.rows !== terminal.rows);
        if ((resizes || frame.enterAlternate) && pending) {
          if (stopped) return;
          await write(terminal, pending);
          pending = "";
        }
        if (stopped) return;
        if (resizes && frame.size) {
          await resizeLikeTmux({ terminal, size: frame.size, alternate });
        }
        if (frame.enterAlternate && !alternate) {
          await scrollScreenIntoDocument(terminal);
        }
        pending += frame.bytes;
      }
      if (pending && !stopped) await write(terminal, pending);
    },
    reset() {
      alternate = false;
      unfinished = "";
    },
    stop() {
      stopped = true;
    },
  };
}

export interface TerminalReplayer {
  /** Write the next bytes of the recording; resolves once xterm parsed them. */
  write(content: string): Promise<void>;
  /** Forget stream state after `terminal.reset()`. */
  reset(): void;
  /** Write nothing more, before the terminal is disposed. */
  stop(): void;
}

/**
 * The recording cut where the terminal changes: each frame names the size
 * the terminal takes before its bytes, or that its bytes enter the
 * alternate screen. `rest` is a sequence the recording ends in the middle of.
 */
export function splitTerminalRecording(content: string): {
  frames: RecordingFrame[];
  rest: string;
} {
  const frames: RecordingFrame[] = [];
  let frame: Omit<RecordingFrame, "bytes"> = {};
  let offset = 0;
  for (const match of content.matchAll(SCREEN_EVENTS)) {
    if (match[1] !== undefined) {
      const size = parseTerminalSize(match[1]);
      // An event with no usable size stays in the stream; xterm ignores it.
      if (!size) continue;
      frames.push({ ...frame, bytes: content.slice(offset, match.index) });
      frame = { size };
      offset = match.index + match[0].length;
    } else if (alternateScreenMode(match[2].split(";").map(Number))) {
      frames.push({ ...frame, bytes: content.slice(offset, match.index) });
      frame = { enterAlternate: true };
      offset = match.index;
    }
  }
  const tail = content.slice(offset);
  const cut = unfinishedSequence(tail);
  frames.push({ ...frame, bytes: tail.slice(0, cut) });
  return { frames, rest: tail.slice(cut) };
}

// ===================== internals =====================

interface RecordingFrame {
  size?: TerminalDimensions;
  enterAlternate?: boolean;
  bytes: string;
}

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);
const SIZE_EVENT_START = "\x1b]777;archestra-terminal-size=";
const SCREEN_EVENTS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: size events and screen modes are terminal protocol bytes
  /\x1b\]777;(archestra-terminal-size=\d+x\d+)(?:\x07|\x1b\\)|\x1b\[\?([\d;]*)h/g;

function alternateScreenMode(modes: number[]): boolean {
  return modes.some((mode) => ALTERNATE_SCREEN_MODES.has(mode));
}

function isNumber(value: number | number[]): value is number {
  return typeof value === "number";
}

/** Where a size event or screen mode the bytes do not finish starts. */
function unfinishedSequence(bytes: string): number {
  const start = bytes.lastIndexOf("\x1b");
  if (start === -1) return bytes.length;
  const candidate = bytes.slice(start);
  if (candidate === "\x1b") {
    // The escape can also open the string terminator of a size event.
    const event = bytes.lastIndexOf("\x1b", start - 1);
    if (
      event !== -1 &&
      bytes.slice(event, start).startsWith(SIZE_EVENT_START) &&
      /^\d+x\d+$/.test(bytes.slice(event + SIZE_EVENT_START.length, start))
    ) {
      return event;
    }
    return start;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an unfinished CSI private mode is terminal protocol bytes
  if (/^\x1b\[(?:\?[\d;]*)?$/.test(candidate)) return start;
  if (SIZE_EVENT_START.startsWith(candidate)) return start;
  return candidate.startsWith(SIZE_EVENT_START) &&
    /^\d+(?:x\d*)?$/.test(candidate.slice(SIZE_EVENT_START.length))
    ? start
    : bytes.length;
}

async function resizeLikeTmux({
  terminal,
  size: { cols, rows },
  alternate,
}: {
  terminal: Terminal;
  size: TerminalDimensions;
  alternate: boolean;
}): Promise<void> {
  if (alternate) {
    // tmux neither reflows the alternate screen nor keeps its history: a
    // smaller pane cuts rows (below the cursor first, then at the top) and a
    // larger one gains blank rows. xterm resizes a Windows pty's buffer
    // without reflow and without taking lines from scrollback, so the
    // alternate screen resizes as one.
    const { cursorX, cursorY } = terminal.buffer.active;
    const cut = Math.max(
      0,
      terminal.rows - rows - (terminal.rows - 1 - cursorY),
    );
    const moves = cut > 0 ? plainCursorMoves(terminal) : null;
    if (moves) {
      await write(
        terminal,
        `${moves.before}\x1b[H\x1b[${cut}M${moves.to(cursorY - cut, cursorX)}`,
      );
    }
    terminal.options.windowsPty = { backend: "winpty", buildNumber: 1 };
    try {
      terminal.resize(cols, rows);
    } finally {
      terminal.options.windowsPty = {};
    }
    if (moves) await write(terminal, moves.after(cursorY - cut, cursorX));
    return;
  }
  // The width first: xterm reflows the buffer and keeps the cursor on its
  // line through that. Then the height.
  if (cols !== terminal.cols) terminal.resize(cols, terminal.rows);
  const buffer = terminal.buffer.active;
  const pulled = Math.min(Math.max(0, rows - terminal.rows), buffer.baseY);
  if (pulled === 0) {
    if (rows !== terminal.rows) terminal.resize(cols, rows);
    return;
  }
  // Lines come back from scrollback with the cursor on the last row. The
  // cursor then moves down by as many rows, as tmux moves it.
  const { cursorX, cursorY } = buffer;
  const moves = plainCursorMoves(terminal);
  await write(terminal, `${moves.before}\x1b[${terminal.rows};1H`);
  terminal.resize(cols, rows);
  const y = Math.min(cursorY + pulled, rows - 1);
  await write(terminal, `${moves.to(y, cursorX)}${moves.after(y, cursorX)}`);
}

/**
 * Cursor moves of the replayer's own are absolute: origin mode goes off and
 * the scroll region opens for them, as a resize resets the region in tmux
 * and in xterm alike, and origin mode comes back afterwards, homing the
 * cursor, so the move is made once more.
 */
function plainCursorMoves(terminal: Terminal): {
  before: string;
  to: (y: number, x: number) => string;
  after: (y: number, x: number) => string;
} {
  const origin = terminal.modes.originMode;
  const to = (y: number, x: number) =>
    `\x1b[${Math.max(0, y) + 1};${Math.max(0, x) + 1}H`;
  return {
    before: "\x1b[?6l\x1b[r",
    to,
    after: (y, x) => (origin ? `\x1b[?6h${to(y, x)}` : ""),
  };
}

/** On entering the alternate screen, the rows written so far join the
 * document above the client's own screen, which starts on blank rows. */
async function scrollScreenIntoDocument(terminal: Terminal): Promise<void> {
  const buffer = terminal.buffer.active;
  const { cursorX, cursorY } = buffer;
  const written =
    cursorX > 0 ||
    (buffer.getLine(buffer.baseY + cursorY)?.translateToString(true).length ??
      0) > 0;
  const moves = plainCursorMoves(terminal);
  await write(
    terminal,
    `${moves.before}\x1b[${terminal.rows};1H${"\n".repeat(cursorY + (written ? 1 : 0))}${moves.to(cursorY, cursorX)}${moves.after(cursorY, cursorX)}`,
  );
}

function write(terminal: Terminal, bytes: string): Promise<void> {
  return new Promise((resolve) => terminal.write(bytes, resolve));
}
