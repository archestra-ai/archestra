import { parse as parseToml } from "smol-toml";

/**
 * Reading policy TOML for the views that show it: the parser keeps no
 * positions, so lines are found by scanning the text for headers and keys.
 */

/** One `[[policy.tool]]` entry, as far as the views read it. */
export type ToolEntry = {
  name: string;
  delta: unknown;
  requires: unknown;
  annotator: unknown;
  tags: string[];
  excludes: string[];
};

/** The parsed document, or null when the text is not valid TOML. */
export function parsePolicyToml(text: string): Record<string, unknown> | null {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every `[[policy.tool]]` entry with a string name, in text order. */
export function toolEntries(text: string): ToolEntry[] {
  const policy = asRecord(parsePolicyToml(text)?.policy);
  const tools = Array.isArray(policy?.tool) ? policy.tool : [];
  return tools.flatMap((tool) => {
    const entry = asRecord(tool);
    return entry && typeof entry.name === "string"
      ? [
          {
            name: entry.name,
            delta: entry.delta,
            requires: entry.requires,
            annotator: entry.annotator,
            tags: stringList(entry.tags),
            excludes: stringList(entry.excludes),
          },
        ]
      : [];
  });
}

/**
 * The 1-based line of every `[[policy.tool]]` header. The n-th header is the
 * n-th entry's line whenever every entry is written as a header.
 */
export function toolHeaderLines(text: string): number[] {
  return arrayHeaderLines(text, ["policy", "tool"]);
}

/** The 1-based line of every `[[a.b]]` array-of-tables header for `path`. */
export function arrayHeaderLines(text: string, path: string[]): number[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      sameKeyPath(ARRAY_HEADER.exec(line)?.[1], path) ? [index + 1] : [],
    );
}

/** The 1-based line of the `[a.b.c]` table header, or null. */
export function tableHeaderLine(text: string, path: string[]): number | null {
  const index = text
    .split("\n")
    .findIndex((line) => sameKeyPath(TABLE_HEADER.exec(line)?.[1], path));
  return index === -1 ? null : index + 1;
}

/**
 * The 1-based line of the first line inside the `[table]` header that
 * satisfies `matches`, or null. Lines of a multi-line value are scanned too.
 */
export function lineInTable(params: {
  text: string;
  table: string[];
  matches: (line: string) => boolean;
}): number | null {
  const lines = params.text.split("\n");
  let inside = false;
  for (const [index, line] of lines.entries()) {
    const header = TABLE_HEADER.exec(line) ?? ARRAY_HEADER.exec(line);
    if (header) {
      inside = sameKeyPath(header[1], params.table);
      continue;
    }
    if (inside && params.matches(line)) return index + 1;
  }
  return null;
}

/** Whether a line assigns the bare or quoted key `key`. */
export function assignsKey(line: string, key: string): boolean {
  const match = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
  return match !== null && unquote(match[1]) === key;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// =============================================================================
// Internal helpers
// =============================================================================

function sameKeyPath(spelled: string | undefined, path: string[]): boolean {
  if (spelled === undefined) return false;
  const keys = spelled.match(KEY_SEGMENT)?.map(unquote) ?? [];
  return keys.length === path.length && keys.every((key, i) => key === path[i]);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function unquote(key: string): string {
  return /^(["']).*\1$/.test(key) ? key.slice(1, -1) : key;
}

const TABLE_HEADER = /^\s*\[(?!\[)\s*([^\]]+?)\s*\](?!\])/;
const ARRAY_HEADER = /^\s*\[\[\s*([^\]]+?)\s*\]\]/;
const KEY_SEGMENT = /"[^"]*"|'[^']*'|[A-Za-z0-9_-]+/g;
