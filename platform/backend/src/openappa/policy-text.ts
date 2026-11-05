import { createHash } from "node:crypto";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/**
 * Reading policy TOML for the views that show it: the parser keeps no
 * positions, so lines are found by scanning the text for headers and keys.
 */

/** One `[[policy.tool]]` entry, as far as the views read it. */
export type ToolEntry = {
  name: string;
  delta: unknown;
  forwards: unknown;
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
            forwards: entry.forwards,
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
// Repository includes
// =============================================================================

/**
 * Repository includes: policy files that live beside `appa.toml` in the Git
 * sync repository and that the root names in its `include` list, such as
 * `include = ["mcp/payments_api.toml"]`.
 *
 * Batteries are the include entries OpenAPPA's own composer answers. A
 * repository include is the host's: before composing, the host folds each
 * file's rules into the root, after the root's own and in include order, so
 * the root's rules for a tool still win and every battery comes after. A file
 * may set only what an OpenAPPA include may set: `[[policy.tool]]`,
 * `[[policy.annotator]]`, `[[policy.authority]]` and `[[policy.sanitizer]]`.
 *
 * Archestra stores none of these files. They are read from the repository at
 * the commit Git sync accepted, so who may change one, and how, is the
 * repository's to decide: its pull requests, reviews and code owners.
 */

/** The `[policy]` arrays an included file may add to. */
const INCLUDABLE = ["tool", "annotator", "authority", "sanitizer"] as const;

/**
 * A repository-relative `.toml` path outside `batteries/`, with no `.` or
 * `..` segment, which the segment pattern rules out by refusing a leading dot.
 */
const REPOSITORY_INCLUDE =
  /^(?!batteries\/)(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.toml$/;

/** A quick test that a text could name one, so most texts skip the parse. */
const MAY_NAME_REPOSITORY_INCLUDE = /["'](?!batteries\/)[^"'\n]*\.toml["']/;

/** The most repository files one root may include. */
const MAX_REPOSITORY_INCLUDES = 64;

/** Whether an `include` entry names a file in the policy repository. */
export function isRepositoryInclude(entry: string): boolean {
  return REPOSITORY_INCLUDE.test(entry);
}

/** The file an MCP server's rules are kept in, by its tools' prefix. */
export function serverRulesPath(toolPrefix: string): string {
  return `mcp/${toolPrefix}.toml`;
}

/** The repository files a root document includes, in its order. */
export function repositoryIncludePaths(content: string): string[] {
  if (!MAY_NAME_REPOSITORY_INCLUDE.test(content)) return [];
  const include = parsePolicyToml(content)?.include;
  if (!Array.isArray(include)) return [];
  return include.filter(
    (entry): entry is string =>
      typeof entry === "string" && isRepositoryInclude(entry),
  );
}

/** The identity of one included file's bytes, for fingerprints and views. */
export function repositoryFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Why `content` could not be an included file, or none. The same check the
 * fold makes, for a caller that wants to refuse a file before it is included.
 */
export function includedFileErrors(path: string, content: string): string[] {
  const parsed = parseIncluded(path, content);
  return "errors" in parsed ? parsed.errors : [];
}

/**
 * The root with every repository include folded in, or the root unchanged
 * when it includes none. `files` holds each included file's text by path.
 * Comments in the root do not survive a fold; the result is composition
 * input, never stored or shown as the policy text.
 */
export function expandRepositoryIncludes(params: {
  content: string;
  files: ReadonlyMap<string, string>;
}): { content: string; errors: string[] } {
  const paths = repositoryIncludePaths(params.content);
  if (paths.length === 0) return { content: params.content, errors: [] };
  // The text parsed above, so this is a table.
  const document = parsePolicyToml(params.content) as Record<string, unknown>;
  const errors: string[] = [];
  if (paths.length > MAX_REPOSITORY_INCLUDES)
    errors.push(
      `include: ${paths.length} repository files are included; at most ${MAX_REPOSITORY_INCLUDES} are allowed`,
    );
  const duplicated = paths.filter(
    (path, index) => paths.indexOf(path) !== index,
  );
  for (const path of new Set(duplicated))
    errors.push(`include: ${JSON.stringify(path)} is included more than once`);
  const policy = asRecord(document.policy) ?? {};
  for (const kind of INCLUDABLE)
    if (policy[kind] !== undefined && !Array.isArray(policy[kind]))
      errors.push(
        `policy.${kind} must be written as [[policy.${kind}]] entries to include repository files`,
      );
  if (errors.length > 0) return { content: params.content, errors };

  const rootHelpers = {
    annotator: helperNames(policy.annotator),
    authority: helperNames(policy.authority),
    sanitizer: helperNames(policy.sanitizer),
  };
  for (const path of paths) {
    const text = params.files.get(path);
    if (text === undefined) {
      errors.push(
        `include: ${JSON.stringify(path)} names no file in the policy repository at this commit`,
      );
      continue;
    }
    const parsed = parseIncluded(path, text, policy.version);
    if ("errors" in parsed) {
      errors.push(...parsed.errors);
      continue;
    }
    for (const kind of INCLUDABLE) {
      const entries = parsed.policy[kind];
      if (!entries) continue;
      // As in OpenAPPA, a helper the root declares under the same name
      // replaces an included one; rules for one tool all stay, root first.
      const kept =
        kind === "tool"
          ? entries
          : entries.filter((entry) => !rootHelpers[kind].has(nameOf(entry)));
      policy[kind] = [...((policy[kind] as unknown[]) ?? []), ...kept];
    }
  }
  if (errors.length > 0) return { content: params.content, errors };

  const include = (document.include as unknown[]).filter(
    (entry) => typeof entry !== "string" || !isRepositoryInclude(entry),
  );
  if (include.length > 0) document.include = include;
  else delete document.include;
  document.policy = policy;
  return { content: stringifyToml(document), errors: [] };
}

function helperNames(entries: unknown): Set<string> {
  return new Set(Array.isArray(entries) ? entries.map(nameOf) : []);
}

function nameOf(entry: unknown): string {
  const name = asRecord(entry)?.name;
  return typeof name === "string" ? name : "";
}

function parseIncluded(
  path: string,
  content: string,
  /** The root's `policy.version`, which an included file must state too. */
  version: unknown = 2,
):
  | { policy: Partial<Record<(typeof INCLUDABLE)[number], unknown[]>> }
  | { errors: string[] } {
  let document: Record<string, unknown>;
  try {
    document = parseToml(content) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    return {
      errors: [`${path}: not valid TOML${reason ? `: ${reason}` : ""}`],
    };
  }
  const allowed =
    "may set only [policy] version and [[policy.tool]], [[policy.annotator]], [[policy.authority]] and [[policy.sanitizer]]";
  const extra = Object.keys(document).filter((key) => key !== "policy");
  if (extra.length > 0)
    return {
      errors: [
        `${path}: an included file ${allowed}; it sets ${extra.join(", ")}`,
      ],
    };
  const { version: stated, ...policy } = asRecord(document.policy) ?? {};
  // OpenAPPA refuses an included file without the policy version, so the
  // repository's own `appa` checks load the same files the host folds.
  const errors: string[] =
    stated === version
      ? []
      : [
          `${path}: start the file with [policy] version = ${JSON.stringify(version)}, as appa.toml does`,
        ];
  for (const [key, value] of Object.entries(policy)) {
    if (!(INCLUDABLE as readonly string[]).includes(key))
      errors.push(
        `${path}: an included file ${allowed}; it sets policy.${key}`,
      );
    else if (!Array.isArray(value) || value.some((entry) => !asRecord(entry)))
      errors.push(`${path}: write policy.${key} as [[policy.${key}]] entries`);
  }
  if (errors.length > 0) return { errors };
  return {
    policy: policy as Partial<Record<(typeof INCLUDABLE)[number], unknown[]>>,
  };
}

/**
 * The root without its repository includes, for a comparison that cannot read
 * their files: it composes as the root would were the files empty.
 */
export function withoutRepositoryIncludes(content: string): string {
  if (repositoryIncludePaths(content).length === 0) return content;
  const document = parsePolicyToml(content) as Record<string, unknown>;
  const include = (document.include as unknown[]).filter(
    (entry) => typeof entry !== "string" || !isRepositoryInclude(entry),
  );
  if (include.length > 0) document.include = include;
  else delete document.include;
  return stringifyToml(document);
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
