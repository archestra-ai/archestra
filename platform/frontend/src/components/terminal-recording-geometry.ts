interface TerminalDimensions {
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

/** Recover geometry for old TUI recordings that predate ordered size events. */
export function prepareTerminalRecording(content: string): {
  content: string;
  dimensions: TerminalDimensions;
} {
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

// Consume OSC payloads as whole tokens, so titles/links cannot look like grids.
const TERMINAL_TOKENS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol tokens are intentional
  /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|─{20,}/g;

function sizeFromToken(token: string): TerminalDimensions | null {
  if (!token.startsWith("\x1b]777;")) return null;
  return parseTerminalSize(token.slice(6, token.endsWith("\x07") ? -1 : -2));
}
