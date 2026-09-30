import type { IBufferCell, Terminal } from "@xterm/xterm";
import type { CSSProperties } from "react";
import { getTerminalRecordingLinkUrl } from "./terminal-recording-links";

/** Copy the parsed buffer; snapshots never retain xterm's mutable cells. */
export function snapshotTerminalRecording(
  terminal: Terminal,
  range?: { start: number; end: number },
): {
  cols: number;
  rows: number;
  lines: RecordingLine[];
} {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const links = recordingLinkReader(terminal);
  const styles = recordingStyleReader();
  const lines: RecordingLine[] = [];
  let lastWrittenRow = -1;
  const start = Math.max(
    0,
    Math.min(buffer.length, Math.floor(range?.start ?? 0)),
  );
  const end = Math.max(
    start,
    Math.min(buffer.length, Math.floor(range?.end ?? buffer.length)),
  );

  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const runs: RecordingRun[] = [];
    let lastWrittenColumn = 0;
    let length = 0;
    for (let x = 0; x < Math.min(line.length, terminal.cols); x++) {
      const value = line.getCell(x, cell);
      if (!value || value.getWidth() === 0) continue;
      const characters = value.getChars();
      const text = characters || " ";
      const cells = value.getWidth();
      const fixedWidth =
        cells !== 1 || text.length !== 1 || text.charCodeAt(0) > 0x7f;
      const style = styles(value);
      const url = links(value);
      const previous = runs.at(-1);
      if (
        previous &&
        !previous.fixedWidth &&
        !fixedWidth &&
        previous.style === style &&
        previous.url === url
      ) {
        previous.text += text;
        previous.cells += cells;
      } else
        runs.push({
          column: x,
          cells,
          fixedWidth,
          text,
          style,
          ...(url !== undefined ? { url } : {}),
        });
      length += text.length;
      if (characters || paintsEmptyCell(value)) lastWrittenColumn = length;
    }
    // Retain the grid gap before a wide glyph wraps, but distinguish it from
    // written spaces so URL inference can reconstruct the original text.
    const trailingPadding = buffer.getLine(y + 1)?.isWrapped
      ? length - lastWrittenColumn
      : 0;
    if (!buffer.getLine(y + 1)?.isWrapped) {
      trimUnwrittenPadding(runs, length - lastWrittenColumn);
    }
    if (lastWrittenColumn > 0) lastWrittenRow = lines.length;
    lines.push({
      row: y,
      runs,
      wrapped: line.isWrapped,
      ...(trailingPadding ? { trailingPadding } : {}),
    });
  }

  // Range callers aggregate chunks before deciding which blank rows are tail.
  if (!range) lines.length = lastWrittenRow + 1;
  return { cols: terminal.cols, rows: terminal.rows, lines };
}

type RecordingRun = {
  column: number;
  cells: number;
  fixedWidth: boolean;
  text: string;
  style: CSSProperties;
  url?: string | null;
};
type RecordingLine = {
  row: number;
  runs: RecordingRun[];
  wrapped: boolean;
  trailingPadding?: number;
};

function paintsEmptyCell(cell: IBufferCell): boolean {
  return Boolean(
    !cell.isBgDefault() ||
      cell.isInverse() ||
      cell.isUnderline() ||
      cell.isStrikethrough() ||
      cell.isOverline(),
  );
}

function trimUnwrittenPadding(runs: RecordingRun[], padding: number): void {
  while (padding > 0) {
    const run = runs.at(-1);
    if (!run) return;
    if (run.text.length <= padding) {
      padding -= run.text.length;
      runs.pop();
    } else {
      run.text = run.text.slice(0, run.text.length - padding);
      run.cells -= padding;
      return;
    }
  }
}

function cellStyle(cell: IBufferCell): CSSProperties {
  const inverse = Boolean(cell.isInverse());
  // xterm swaps color sources before bold brightens the resulting foreground.
  let foreground = cellColor({
    cell,
    foreground: !inverse,
    brighten: Boolean(cell.isBold()),
  });
  const background = cellColor({
    cell,
    foreground: inverse,
    brighten: false,
  });
  if (cell.isDim())
    foreground = `color-mix(in srgb, ${foreground} 50%, ${background})`;
  const decorations = [
    cell.isUnderline() ? "underline" : "",
    cell.isStrikethrough() ? "line-through" : "",
    cell.isOverline() ? "overline" : "",
  ].filter(Boolean);
  return {
    color: cell.isInvisible() ? "transparent" : foreground,
    backgroundColor: background,
    ...(cell.isBold() ? { fontWeight: "bold" } : {}),
    ...(cell.isItalic() ? { fontStyle: "italic" } : {}),
    ...(decorations.length
      ? { textDecorationLine: decorations.join(" ") }
      : {}),
  };
}

function cellColor({
  cell,
  foreground,
  brighten,
}: {
  cell: IBufferCell;
  foreground: boolean;
  brighten: boolean;
}): string {
  const color = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return rgb(color);
  if (foreground ? cell.isFgPalette() : cell.isBgPalette())
    return palette(color + (brighten && color < 8 ? 8 : 0));
  return foreground ? "#34d399" : "#020617";
}

function recordingStyleReader(): (cell: IBufferCell) => CSSProperties {
  const attributes = new Map<string, CSSProperties>();
  const styles = new Map<string, CSSProperties>();
  return (cell) => {
    const flags =
      Number(Boolean(cell.isInverse())) |
      (Number(Boolean(cell.isBold())) << 1) |
      (Number(Boolean(cell.isDim())) << 2) |
      (Number(Boolean(cell.isInvisible())) << 3) |
      (Number(Boolean(cell.isItalic())) << 4) |
      (Number(Boolean(cell.isUnderline())) << 5) |
      (Number(Boolean(cell.isStrikethrough())) << 6) |
      (Number(Boolean(cell.isOverline())) << 7);
    const key = `${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.getBgColorMode()}:${cell.getBgColor()}:${flags}`;
    const cached = attributes.get(key);
    if (cached) return cached;
    const next = cellStyle(cell);
    const styleKey = JSON.stringify(next);
    const style = styles.get(styleKey) ?? next;
    styles.set(styleKey, style);
    attributes.set(key, style);
    return style;
  };
}

function rgb(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function palette(index: number): string {
  if (index < 16) return ANSI_COLORS[index];
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return rgb((gray << 16) | (gray << 8) | gray);
  }
  const offset = index - 16;
  const channels = [0, 95, 135, 175, 215, 255];
  return rgb(
    (channels[Math.floor(offset / 36)] << 16) |
      (channels[Math.floor(offset / 6) % 6] << 8) |
      channels[offset % 6],
  );
}

function recordingLinkReader(
  terminal: Terminal,
): (cell: IBufferCell) => string | null | undefined {
  // xterm 6.0.0's public cells omit OSC8 targets. Keep this compatibility
  // boundary isolated and exercised with real xterm; missing internals leave
  // the text readable rather than fabricating a destination from its label.
  // Reused CellData retains its previous .extended when HAS_EXTENDED is absent;
  // reading urlId without that flag leaks a link onto following ordinary cells.
  const service = (
    terminal as unknown as {
      _core?: {
        _oscLinkService?: {
          getLinkData(id: number): { uri: string } | undefined;
        };
      };
    }
  )._core?._oscLinkService;
  const urls = new Map<number, string | null>();
  return (cell) => {
    const linkedCell = cell as IBufferCell & {
      hasExtendedAttrs?: () => number;
      extended?: { urlId?: number };
    };
    if (!linkedCell.hasExtendedAttrs?.()) return undefined;
    const id = linkedCell.extended?.urlId;
    if (!id) return undefined;
    if (typeof service?.getLinkData !== "function") return null;
    if (!urls.has(id)) {
      const target = service.getLinkData(id)?.uri;
      urls.set(id, target ? getTerminalRecordingLinkUrl(target) : null);
    }
    return urls.get(id);
  };
}

const ANSI_COLORS = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec",
];
