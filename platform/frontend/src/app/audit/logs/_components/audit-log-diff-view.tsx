"use client";

import { cn } from "@/lib/utils";

/** Top-level audit `before` / `after` payloads from the API. */
export type AuditSnapshot = Record<string, unknown>;

export type DiffKind = "context" | "added" | "removed";

export type DiffLine = {
  kind: DiffKind;
  /** Number of indent levels (2 spaces per level). */
  indent: number;
  /** The literal text after the leading glyph. */
  text: string;
};

type DiffLineWithKey = DiffLine & { rowKey: string };

function assignStableRowKeys(lines: DiffLine[]): DiffLineWithKey[] {
  const counts = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.kind}|${line.indent}|${line.text}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    const rowKey = n === 0 ? base : `${base}#${n}`;
    return { ...line, rowKey };
  });
}

interface AuditLogDiffViewProps {
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
  /** Optional label shown in the empty state. */
  emptyMessage?: string;
}

/**
 * Renders a git-diff-style view of two JSON snapshots produced by the audit
 * log's `before` / `after` columns.
 *
 * The output is **valid-looking JSON** wrapped in `{ … }` with quoted keys,
 * full context lines, and `+` / `-` glyphs only on changed lines — mirroring
 * the diff-tool aesthetic the issue maintainer asked for.
 *
 * - Both null → "no tracked changes" empty state (typical of auth events).
 * - Before null → every line tagged `added` (create).
 * - After null → every line tagged `removed` (delete).
 * - Both populated → unified diff with full context.
 */
export function AuditLogDiffView({
  before,
  after,
  emptyMessage = "No tracked changes for this event.",
}: AuditLogDiffViewProps) {
  const bothNull = before === null && after === null;
  const lines = bothNull ? [] : computeDiffLines(before, after);
  const keyedLines = assignStableRowKeys(lines);

  if (bothNull) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  if (lines.length === 0 || lines.every((l) => l.kind === "context")) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        No field-level differences between the snapshots.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border bg-muted/20 font-mono text-xs">
      <ul className="divide-y divide-border/50">
        {keyedLines.map((line) => (
          <li
            key={line.rowKey}
            data-diff-kind={line.kind}
            className={cn(
              "flex whitespace-pre",
              line.kind === "added" && "bg-emerald-500/10 text-emerald-700",
              line.kind === "removed" && "bg-red-500/10 text-red-700",
              line.kind === "context" && "text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className="select-none px-2 py-0.5 text-muted-foreground/70"
            >
              {line.kind === "added"
                ? "+"
                : line.kind === "removed"
                  ? "-"
                  : " "}
            </span>
            <span className="flex-1 break-all py-0.5 pr-3">
              {indentSpaces(line.indent)}
              {line.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// === Internal helpers

const INDENT = "  ";

function indentSpaces(level: number): string {
  return INDENT.repeat(level);
}

export function computeDiffLines(
  before: AuditSnapshot | null,
  after: AuditSnapshot | null,
): DiffLine[] {
  if (before === null && after !== null) {
    return renderFullBlock(after, "added");
  }
  if (after === null && before !== null) {
    return renderFullBlock(before, "removed");
  }
  if (before === null || after === null) {
    return [];
  }
  return diffObjectAsBlock(before, after, 0, false);
}

/**
 * Produces a JSON-shaped unified diff for an object pair. `terminated` controls
 * whether the closing `}` gets a trailing comma (used when nested inside a
 * parent object/array).
 */
function diffObjectAsBlock(
  before: AuditSnapshot,
  after: AuditSnapshot,
  indent: number,
  terminated: boolean,
): DiffLine[] {
  const out: DiffLine[] = [{ kind: "context", indent, text: "{" }];
  const keys = orderedUnionKeys(before, after);

  keys.forEach((key, i) => {
    const isLast = i === keys.length - 1;
    const hasBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);

    if (hasBefore && !hasAfter) {
      out.push(
        ...renderField(key, before[key], "removed", indent + 1, !isLast),
      );
      return;
    }
    if (!hasBefore && hasAfter) {
      out.push(...renderField(key, after[key], "added", indent + 1, !isLast));
      return;
    }

    const beforeValue = before[key];
    const afterValue = after[key];

    if (deepEqual(beforeValue, afterValue)) {
      out.push(
        ...renderField(key, beforeValue, "context", indent + 1, !isLast),
      );
      return;
    }

    // Both sides have the key with different values.
    if (isPlainObject(beforeValue) && isPlainObject(afterValue)) {
      const nested = diffObjectAsBlock(
        beforeValue,
        afterValue,
        indent + 1,
        !isLast,
      );
      // Prepend `"key": ` to the opening `{` line so the diff reads naturally.
      const [opening, ...rest] = nested;
      out.push({
        kind: "context",
        indent: indent + 1,
        text: `${quoteKey(key)}: ${opening.text}`,
      });
      out.push(...rest);
      return;
    }

    if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
      out.push(
        ...diffArrayAsBlock(key, beforeValue, afterValue, indent + 1, !isLast),
      );
      return;
    }

    // Mixed types or primitive vs primitive → emit removed then added.
    out.push(...renderField(key, beforeValue, "removed", indent + 1, !isLast));
    out.push(...renderField(key, afterValue, "added", indent + 1, !isLast));
  });

  out.push({ kind: "context", indent, text: terminated ? "}," : "}" });
  return out;
}

/**
 * Position-by-position array diff. Equal elements stay as context; mismatches
 * render the before element as removed immediately followed by the after
 * element as added — like `git diff` on a sorted list.
 */
function diffArrayAsBlock(
  key: string,
  before: unknown[],
  after: unknown[],
  indent: number,
  terminated: boolean,
): DiffLine[] {
  const out: DiffLine[] = [
    { kind: "context", indent, text: `${quoteKey(key)}: [` },
  ];

  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const isLast = i === max - 1;
    const inBefore = i < before.length;
    const inAfter = i < after.length;
    if (inBefore && inAfter) {
      const a = before[i];
      const b = after[i];
      if (deepEqual(a, b)) {
        out.push(...renderValueAsItem(a, "context", indent + 1, !isLast));
      } else {
        out.push(
          ...renderValueAsItem(a, "removed", indent + 1, !isLast),
          ...renderValueAsItem(b, "added", indent + 1, !isLast),
        );
      }
    } else if (inBefore) {
      out.push(...renderValueAsItem(before[i], "removed", indent + 1, !isLast));
    } else if (inAfter) {
      out.push(...renderValueAsItem(after[i], "added", indent + 1, !isLast));
    }
  }

  out.push({ kind: "context", indent, text: terminated ? "]," : "]" });
  return out;
}

/**
 * Renders a `before` (or `after`) snapshot as a single-kind block — used for
 * create / delete events where the other side is null.
 */
function renderFullBlock(value: AuditSnapshot, kind: DiffKind): DiffLine[] {
  const out: DiffLine[] = [{ kind, indent: 0, text: "{" }];
  const keys = Object.keys(value);
  keys.forEach((key, i) => {
    const isLast = i === keys.length - 1;
    out.push(...renderField(key, value[key], kind, 1, !isLast));
  });
  out.push({ kind, indent: 0, text: "}" });
  return out;
}

function renderField(
  key: string,
  value: unknown,
  kind: DiffKind,
  indent: number,
  trailingComma: boolean,
): DiffLine[] {
  if (isPlainObject(value) || Array.isArray(value)) {
    const formatted = formatJsonLines(value, indent);
    if (formatted.length === 0) {
      return [
        {
          kind,
          indent,
          text: `${quoteKey(key)}: ${isPlainObject(value) ? "{}" : "[]"}${trailingComma ? "," : ""}`,
        },
      ];
    }
    const [first, ...rest] = formatted;
    const last = rest.length > 0 ? rest[rest.length - 1] : null;
    const head: DiffLine = {
      kind,
      indent,
      text: `${quoteKey(key)}: ${first.text}`,
    };
    const middle = rest.slice(0, -1).map((line) => ({ ...line, kind }));
    const tail: DiffLine[] = last
      ? [
          {
            kind,
            indent: last.indent,
            text: `${last.text}${trailingComma ? "," : ""}`,
          },
        ]
      : [];
    return [head, ...middle, ...tail];
  }
  return [
    {
      kind,
      indent,
      text: `${quoteKey(key)}: ${formatPrimitive(value)}${trailingComma ? "," : ""}`,
    },
  ];
}

function renderValueAsItem(
  value: unknown,
  kind: DiffKind,
  indent: number,
  trailingComma: boolean,
): DiffLine[] {
  if (isPlainObject(value) || Array.isArray(value)) {
    const formatted = formatJsonLines(value, indent);
    if (formatted.length === 0) {
      return [
        {
          kind,
          indent,
          text: `${isPlainObject(value) ? "{}" : "[]"}${trailingComma ? "," : ""}`,
        },
      ];
    }
    return formatted.map((line, i, arr) => ({
      ...line,
      kind,
      text: i === arr.length - 1 && trailingComma ? `${line.text},` : line.text,
    }));
  }
  return [
    {
      kind,
      indent,
      text: `${formatPrimitive(value)}${trailingComma ? "," : ""}`,
    },
  ];
}

/**
 * Pretty-print a value as a sequence of indented JSON lines starting at the
 * given indent depth.  Used for both nested objects and array elements.
 */
function formatJsonLines(value: unknown, indent: number): DiffLine[] {
  const pretty = JSON.stringify(value, null, 2);
  if (pretty === undefined) {
    return [{ kind: "context", indent, text: "undefined" }];
  }
  const rawLines = pretty.split("\n");
  return rawLines.map((raw) => {
    // Count leading spaces from JSON.stringify (2 per level) to recover depth.
    const match = raw.match(/^ */);
    const leadingSpaces = match ? match[0].length : 0;
    const depthFromJson = Math.floor(leadingSpaces / 2);
    return {
      kind: "context",
      indent: indent + depthFromJson,
      text: raw.slice(leadingSpaces),
    };
  });
}

function formatPrimitive(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quoteKey(key: string): string {
  return JSON.stringify(key);
}

function orderedUnionKeys(a: AuditSnapshot, b: AuditSnapshot): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of Object.keys(a)) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const key of Object.keys(b)) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is AuditSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const AUDIT_DIFF_METADATA_KEYS = new Set(["updatedAt", "createdAt"]);

/**
 * One-line summary of which top-level fields differ between two audit
 * snapshots (shown above the diff for update events).
 */
export function summarizeAuditDiffHints(
  before: AuditSnapshot | null,
  after: AuditSnapshot | null,
): string | null {
  if (before === null && after === null) return null;

  if (before === null && after !== null) {
    const keys = Object.keys(after).filter(
      (k) => !AUDIT_DIFF_METADATA_KEYS.has(k),
    );
    if (keys.length === 0) {
      return "Created resource (see snapshot below).";
    }
    return `Created — captured fields: ${keys.sort().join(", ")}.`;
  }

  if (after === null && before !== null) {
    const keys = Object.keys(before).filter(
      (k) => !AUDIT_DIFF_METADATA_KEYS.has(k),
    );
    if (keys.length === 0) {
      return "Deleted resource (see prior snapshot below).";
    }
    return `Deleted — had fields: ${keys.sort().join(", ")}.`;
  }

  if (before !== null && after !== null) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const substantive: string[] = [];
    for (const key of keys) {
      if (AUDIT_DIFF_METADATA_KEYS.has(key)) continue;
      if (!deepEqual(before[key], after[key])) substantive.push(key);
    }
    if (substantive.length > 0) {
      return `Changed: ${substantive.sort().join(", ")}.`;
    }
    for (const key of AUDIT_DIFF_METADATA_KEYS) {
      if (keys.has(key) && !deepEqual(before[key], after[key])) {
        return "Only timestamp fields changed; all other captured fields match.";
      }
    }
  }
  return null;
}
