import type { Terminal } from "@xterm/xterm";
import { parseTerminalSize } from "./terminal-recording-geometry";

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
 * entry, the screen in view scrolls into the document rather than being
 * erased by the client's first clear. While the alternate screen is on, a
 * pane that shrinks drops its top rows and a pane that grows takes nothing
 * back, as tmux's alternate screen has no history.
 */
export function createTerminalReplayer(terminal: Terminal): TerminalReplayer {
  let alternate = false;
  /** Bytes a live stream ended with that do not finish a sequence yet. */
  let unfinished = "";
  const alternateScreenMode = (params: (number | number[])[]) =>
    params.some(
      (param) => typeof param === "number" && ALTERNATE_SCREEN_MODES.has(param),
    );
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (!alternateScreenMode(params)) return false;
    alternate = true;
    return true;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (!alternateScreenMode(params)) return false;
    alternate = false;
    return true;
  });
  return {
    async write(content) {
      const { frames, rest } = splitTerminalRecording(unfinished + content);
      unfinished = rest;
      for (const frame of frames) {
        if (frame.size) await resizeLikeTmux(terminal, frame.size, alternate);
        if (frame.enterAlternate && !alternate) {
          // The rows written so far join the document above the client's own
          // screen, which starts on blank rows.
          const buffer = terminal.buffer.active;
          const { cursorX, cursorY } = buffer;
          const written =
            cursorX > 0 ||
            (buffer.getLine(buffer.baseY + cursorY)?.translateToString(true)
              .length ?? 0) > 0;
          await write(
            terminal,
            `\x1b[${terminal.rows};1H${"\n".repeat(cursorY + (written ? 1 : 0))}\x1b[${cursorY + 1};${cursorX + 1}H`,
          );
        }
        if (frame.bytes) await write(terminal, frame.bytes);
      }
    },
    reset() {
      alternate = false;
      unfinished = "";
    },
  };
}

export interface TerminalReplayer {
  /** Write the next bytes of the recording; resolves once xterm parsed them. */
  write(content: string): Promise<void>;
  /** Forget stream state after `terminal.reset()`. */
  reset(): void;
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
    if (match[1]) {
      const size = parseTerminalSize(match[1]);
      // An event with no usable size stays in the stream; xterm ignores it.
      if (!size) continue;
      frames.push({ ...frame, bytes: content.slice(offset, match.index) });
      frame = { size };
      offset = match.index + match[0].length;
    } else if (
      match[2]
        .split(";")
        .some((mode) => ALTERNATE_SCREEN_MODES.has(Number(mode)))
    ) {
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

interface TerminalDimensions {
  cols: number;
  rows: number;
}

const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);
const SIZE_EVENT_START = "\x1b]777;archestra-terminal-size=";
const SCREEN_EVENTS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: size events and screen modes are terminal protocol bytes
  /\x1b\]777;(archestra-terminal-size=\d+x\d+)(?:\x07|\x1b\\)|\x1b\[\?([\d;]*)h/g;

/** Where a size event or screen mode the bytes do not finish starts. */
function unfinishedSequence(bytes: string): number {
  const start = bytes.lastIndexOf("\x1b");
  if (start === -1) return bytes.length;
  const candidate = bytes.slice(start);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: an unfinished CSI private mode is terminal protocol bytes
  if (/^\x1b(?:\[(?:\?[\d;]*)?)?$/.test(candidate)) return start;
  if (candidate.length <= SIZE_EVENT_START.length) {
    return SIZE_EVENT_START.startsWith(candidate) ? start : bytes.length;
  }
  return candidate.startsWith(SIZE_EVENT_START) &&
    /^\d+(?:x\d*)?$/.test(candidate.slice(SIZE_EVENT_START.length))
    ? start
    : bytes.length;
}

async function resizeLikeTmux(
  terminal: Terminal,
  { cols, rows }: TerminalDimensions,
  alternate: boolean,
): Promise<void> {
  const buffer = terminal.buffer.active;
  const { cursorX, cursorY } = buffer;
  if (alternate) {
    // tmux neither reflows the alternate screen nor keeps its history: a
    // smaller pane cuts rows (below the cursor first, then at the top) and a
    // larger one gains blank rows. xterm resizes a Windows pty's buffer
    // without reflow and without taking lines from scrollback, so the
    // alternate screen resizes as one.
    const cut = Math.max(
      0,
      terminal.rows - rows - (terminal.rows - 1 - cursorY),
    );
    if (cut > 0) {
      await write(
        terminal,
        `\x1b[H\x1b[${cut}M\x1b[${cursorY - cut + 1};${cursorX + 1}H`,
      );
    }
    terminal.options.windowsPty = { backend: "winpty", buildNumber: 1 };
    try {
      terminal.resize(cols, rows);
    } finally {
      terminal.options.windowsPty = {};
    }
    return;
  }
  const pulled = Math.min(Math.max(0, rows - terminal.rows), buffer.baseY);
  if (pulled === 0) {
    terminal.resize(cols, rows);
    return;
  }
  // Lines come back from scrollback with the cursor on the last row. The
  // cursor then moves down by as many rows, as tmux moves it.
  await write(terminal, `\x1b[${terminal.rows};1H`);
  terminal.resize(cols, rows);
  await write(
    terminal,
    `\x1b[${Math.min(cursorY + pulled, rows - 1) + 1};${Math.min(cursorX, cols - 1) + 1}H`,
  );
}

function write(terminal: Terminal, bytes: string): Promise<void> {
  return new Promise((resolve) => terminal.write(bytes, resolve));
}
