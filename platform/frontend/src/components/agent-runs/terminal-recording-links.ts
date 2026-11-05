import type { snapshotTerminalRecording } from "./terminal-recording-snapshot";

/** Resolve only the URL schemes that a recording is allowed to open. */
export function getTerminalRecordingLinkUrl(text: string): string | null {
  if (
    /[\s\\\p{Cc}]/u.test(text) ||
    !/^(?:https?:\/\/[^/?#]+|file:\/\/)/i.test(text)
  ) {
    return null;
  }

  try {
    const url = new URL(text);
    if (url.protocol === "file:") return url.href;
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname
    ) {
      return url.href;
    }
  } catch {
    // Malformed targets remain readable terminal text.
  }
  return null;
}

/** Infer URLs from rendered logical lines, including styled and soft-wrapped text. */
export function inferTerminalRecordingLinks(
  lines: ReturnType<typeof snapshotTerminalRecording>["lines"],
): void {
  for (let start = 0; start < lines.length; ) {
    let end = start + 1;
    while (end < lines.length && lines[end].wrapped) end++;
    const group = lines.slice(start, end);
    const text = group
      .map((line) =>
        line.runs
          .map((run) => run.text)
          .join("")
          .slice(0, line.trailingPadding ? -line.trailingPadding : undefined),
      )
      .join("");
    const matches = [...text.matchAll(/(?:https?:\/\/|file:\/\/)[^\s<>"'`]+/gi)]
      .filter(
        (match) => !match.index || !/[\w:/.@%+-]/.test(text[match.index - 1]),
      )
      .flatMap((match) => {
        const label = trimLinkPunctuation(match[0]);
        const url = getTerminalRecordingLinkUrl(label);
        return url
          ? [{ start: match.index, end: match.index + label.length, url }]
          : [];
      });
    start = end;
    if (!matches.length) continue;
    let offset = 0;
    let index = 0;
    for (const line of group) {
      let remaining =
        line.runs.reduce((length, run) => length + run.text.length, 0) -
        (line.trailingPadding ?? 0);
      line.runs = line.runs.flatMap((run) => {
        const runStart = offset;
        const length = Math.min(run.text.length, remaining);
        remaining -= length;
        offset += length;
        const runEnd = offset;
        // Explicit OSC8 destinations (including rejected ones) own their label.
        if (run.url !== undefined) return [run];
        const pieces: typeof line.runs = [];
        let position = runStart;
        while (position < runEnd) {
          while (matches[index]?.end <= position) index++;
          const match = matches[index];
          const linked = match && position >= match.start;
          const next = Math.min(
            runEnd,
            match ? (linked ? match.end : match.start) : runEnd,
          );
          const slice = position - runStart;
          pieces.push({
            ...run,
            text: run.text.slice(slice, next - runStart),
            column: run.column + (run.fixedWidth ? 0 : slice),
            cells: run.fixedWidth ? run.cells : next - position,
            ...(linked ? { url: match.url } : {}),
          });
          position = next;
        }
        if (length < run.text.length)
          pieces.push({
            ...run,
            text: run.text.slice(length),
            column: run.column + length,
            cells: run.cells - length,
          });
        return pieces;
      });
    }
  }
}

// ===================== internals =====================

function trimLinkPunctuation(text: string): string {
  const counts: Record<string, number> = {};
  for (const character of text) {
    if ("()[]{}".includes(character)) {
      counts[character] = (counts[character] ?? 0) + 1;
    }
  }
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1];
    if (/[.,;:!?]/.test(last)) {
      end--;
      continue;
    }
    const opening = CLOSING_BRACKETS[last];
    if (opening && (counts[opening] ?? 0) < (counts[last] ?? 0)) {
      counts[last]--;
      end--;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

const CLOSING_BRACKETS: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};
