"use client";

import { cn } from "@/lib/utils";

type JsonValue = any;
type JsonObject = { [key: string]: any };

type DiffLine = {
  kind: "context" | "added" | "removed";
  /** Number of indent levels (2 spaces per level). */
  indent: number;
  /** The literal text after the leading glyph. */
  text: string;
};

interface AuditLogDiffViewProps {
  prior: JsonObject | null;
  post: JsonObject | null;
  /** Optional label shown in the empty state. */
  emptyMessage?: string;
}

/**
 * Renders a git-diff-style view between two JSON snapshots produced by the
 * audit log's `prior_state` / `post_state` columns.
 *
 * - Both null → "no tracked changes" empty state (typical of auth events).
 * - Prior null → full block of `+` lines (create).
 * - Post null → full block of `-` lines (delete).
 * - Both populated → field-level unified diff with `+` / `-` glyphs.
 */
export function AuditLogDiffView({
  prior,
  post,
  emptyMessage = "No tracked changes for this event.",
}: AuditLogDiffViewProps) {
  if (prior === null && post === null) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  const lines = computeDiffLines(prior, post);

  if (lines.length === 0) {
    return (
      <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        No field-level differences between the snapshots.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border bg-muted/20 font-mono text-xs">
      <ul role="list" className="divide-y divide-border/50">
        {lines.map((line, i) => (
          <li
            // The diff is content-derived and order-stable; a positional key is
            // fine here because the list is fully re-rendered when prior/post
            // change.
            key={i}
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
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
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

function indentSpaces(level: number): string {
  return "  ".repeat(level);
}

function computeDiffLines(
  prior: JsonObject | null,
  post: JsonObject | null,
): DiffLine[] {
  if (prior === null && post !== null) {
    return renderFullBlock(post, "added", 0);
  }
  if (post === null && prior !== null) {
    return renderFullBlock(prior, "removed", 0);
  }
  if (prior === null || post === null) {
    return [];
  }
  return diffJsonObjects(prior, post, 0);
}

function diffJsonObjects(
  prior: JsonObject,
  post: JsonObject,
  indent: number,
): DiffLine[] {
  const out: DiffLine[] = [];
  const keys = orderedUnionKeys(prior, post);

  for (const key of keys) {
    const hasPrior = Object.hasOwn(prior, key);
    const hasPost = Object.hasOwn(post, key);

    if (hasPrior && !hasPost) {
      out.push(...renderField(key, prior[key], "removed", indent));
      continue;
    }
    if (!hasPrior && hasPost) {
      out.push(...renderField(key, post[key], "added", indent));
      continue;
    }

    const priorValue = prior[key];
    const postValue = post[key];

    if (deepEqual(priorValue, postValue)) {
      continue;
    }

    // Both sides have the key with different values.
    if (isJsonObject(priorValue) && isJsonObject(postValue)) {
      const nested = diffJsonObjects(priorValue, postValue, indent + 1);
      if (nested.length > 0) {
        out.push({ kind: "context", indent, text: `${key}: {` });
        out.push(...nested);
        out.push({ kind: "context", indent, text: "}" });
      }
      continue;
    }

    out.push(...renderField(key, priorValue, "removed", indent));
    out.push(...renderField(key, postValue, "added", indent));
  }

  return out;
}

function renderFullBlock(
  value: JsonObject,
  kind: "added" | "removed",
  indent: number,
): DiffLine[] {
  const out: DiffLine[] = [];
  for (const key of Object.keys(value)) {
    out.push(...renderField(key, value[key], kind, indent));
  }
  return out;
}

function renderField(
  key: string,
  value: JsonValue,
  kind: "added" | "removed",
  indent: number,
): DiffLine[] {
  if (isJsonObject(value) || Array.isArray(value)) {
    const formatted = formatJson(value);
    const [first, ...rest] = formatted;
    return [
      { kind, indent, text: `${key}: ${first ?? ""}` },
      ...rest.map((text) => ({ kind, indent, text })),
    ];
  }
  return [{ kind, indent, text: `${key}: ${formatPrimitive(value)}` }];
}

function formatJson(value: JsonValue): string[] {
  const pretty = JSON.stringify(value, null, 2);
  if (pretty === undefined) {
    return ["undefined"];
  }
  // The first line is anchored next to the key; continuation lines get one
  // extra indent level so nested structures align visually.
  return pretty.split("\n").map((line, i) => (i === 0 ? line : `  ${line}`));
}

function formatPrimitive(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function orderedUnionKeys(a: JsonObject, b: JsonObject): string[] {
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

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k] as JsonValue),
    );
  }
  return false;
}
