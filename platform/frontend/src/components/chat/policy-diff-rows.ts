/**
 * Rows for the policy preview's diff view: numbered lines with no
 * `---`/`+++`/`@@` headers, and each run of unchanged lines the diff left out
 * folded into one gap row.
 */
export type PolicyDiffRow =
  | { kind: "context" | "add"; line: number; text: string }
  | { kind: "remove"; line: null; text: string }
  | { kind: "gap" };

/**
 * `diff` is a unified diff trimmed to its hunks, as the backend sends it, or
 * a whole-file one built in the browser. With no saved policy before it (or
 * the unsaved starter, previewed unchanged) every line of `after` is new.
 */
export function getPolicyDiffRows({
  before,
  after,
  diff,
}: {
  before: string;
  after: string;
  diff: string | null;
}): PolicyDiffRow[] {
  const afterLines = splitLines(after);
  if (before.trim() === "" || before === after || !diff) {
    return afterLines.map((text, index) => ({
      kind: "add",
      line: index + 1,
      text,
    }));
  }

  const rows: PolicyDiffRow[] = [];
  // The next line of `after` the rows have not reached yet.
  let next = 1;
  let inHunk = false;
  for (const raw of diff.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      const start = Number(hunk[1]);
      if (start > next) rows.push({ kind: "gap" });
      next = Math.max(next, start);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const text = raw.slice(1);
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", line: next++, text });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "remove", line: null, text });
    } else {
      rows.push({ kind: "context", line: next++, text });
    }
  }
  if (afterLines.length >= next) rows.push({ kind: "gap" });
  return rows;
}

function splitLines(text: string) {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}
