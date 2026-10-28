export interface TerminalDimensions {
  cols: number;
  rows: number;
}

/** Size events belong to the byte stream so resizing happens before its redraw. */
export function parseTerminalSize(data: string): TerminalDimensions | null {
  const match = /^archestra-terminal-size=(\d+)x(\d+)$/.exec(data);
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000
    ? { cols, rows }
    : null;
}

/**
 * Recover geometry for old TUI recordings that predate ordered size events,
 * and leave out the fenced answer that precedes a captured screen.
 */
export function prepareTerminalRecording(content: string): {
  content: string;
  dimensions: TerminalDimensions;
} {
  content = content
    .replace(FENCED_ANSWER_BEFORE_CAPTURE, "")
    .replace(CAPTURED_SCREEN, (screen, rows: string) => {
      let remaining = Number(rows);
      return screen.replace(/\r?\n/g, (newline) =>
        remaining-- > 0 ? `\x1b[K${newline}` : newline,
      );
    });
  const tokens = Array.from(content.matchAll(TERMINAL_TOKENS));
  const exact = tokens.find((token) => sizeFromToken(token[0]));
  const legacyEnd = exact?.index ?? content.length;
  const clears = tokens.filter(
    (token) => token.index < legacyEnd && token[0] === "\x1b[2J",
  );
  const inserts: { offset: number; marker: string }[] = [];
  let tokenIndex = 0;
  for (let index = 0; index < clears.length; index++) {
    const start = clears[index].index;
    const end = clears[index + 1]?.index ?? legacyEnd;
    let cols = 0;
    let rows = 0;
    while (tokenIndex < tokens.length && tokens[tokenIndex].index < start)
      tokenIndex++;
    while (tokenIndex < tokens.length && tokens[tokenIndex].index < end) {
      const token = tokens[tokenIndex++];
      if (token[0].startsWith("─")) cols = Math.max(cols, token[0].length);
      // Full-width rules and bottom-row cursor addresses together identify a
      // legacy TUI grid. Plain log text alone cannot tell us its terminal size.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: CSI cursor addresses are terminal protocol bytes
      const address = /^\x1b\[(\d+);\d+H$/.exec(token[0]);
      if (address) rows = Math.max(rows, Number(address[1]));
    }
    if (cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) {
      inserts.push({
        offset: start,
        marker: `\x1b]777;archestra-terminal-size=${cols}x${rows}\x07`,
      });
    }
  }
  let prepared = "";
  let offset = 0;
  for (const insert of inserts) {
    prepared += content.slice(offset, insert.offset) + insert.marker;
    offset = insert.offset;
  }
  prepared += content.slice(offset);
  const firstSize = inserts[0]?.marker ?? exact?.[0];
  return {
    content: prepared,
    dimensions: (firstSize && sizeFromToken(firstSize)) || {
      cols: 120,
      rows: 40,
    },
  };
}

// ===================== internals =====================

// A maintained image ends a turn under a full-screen client with the answer
// between fences, then a capture of the client's screen behind a clear.
// Replayed, the answer scrolls that screen up by its own length before the
// capture repaints it, so the screen's top rows stayed in the document twice.
// The answer reaches the reader as the run's result; the document keeps the
// captured screen. The last fence before the clear is the answer's, as the
// backend reads it: a client can scroll an earlier one back into view. An
// answer with nothing after it stays, as the only output of a run without a
// terminal.
// The tempered match is linear in the answer's length for each fence, and
// a fenced answer is a few kilobytes.
const FENCED_ANSWER_BEFORE_CAPTURE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the clear that starts the capture is a terminal control
  /\r?\n?===ARCHESTRA-FINAL-ANSWER===(?:(?!===ARCHESTRA-FINAL-ANSWER===)[\s\S])*?===ARCHESTRA-FINAL-ANSWER-END===\r?\n?(?=(?:\x1b\[[0-?]*[ -/]*[@-~])*?\x1b\[2J)/g;

// The captured screen: its size, then `tmux capture-pane -e` output, which is
// text, SGR attributes carried from line to line, and hyperlinks. tmux drops
// the cells at a line's end that an erase cleared, and without -N (images
// before it) also the spaces a client wrote there, so a background that
// reached the edge (a client's side panel) stopped at the last character.
// Erasing to each line's end in the attribute in effect there restores it, for
// every capture; on a line already full, or in the default background, the
// erase changes nothing. Only the screen's own rows are erased: plain output
// can follow it in the same match.
const CAPTURED_SCREEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the clear, size event and attributes are terminal controls
  /\x1b\[2J\x1b\[H\x1b\]777;archestra-terminal-size=\d+x(\d+)\x07[^\x1b]*(?:(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))[^\x1b]*)*/g;

// Consume OSC payloads as whole tokens, so titles/links cannot look like grids.
const TERMINAL_TOKENS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol tokens are intentional
  /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|─{20,}/g;

function sizeFromToken(token: string): TerminalDimensions | null {
  if (!token.startsWith("\x1b]777;")) return null;
  return parseTerminalSize(token.slice(6, token.endsWith("\x07") ? -1 : -2));
}
