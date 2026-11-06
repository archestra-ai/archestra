import { createHash } from "node:crypto";
import { parseFullToolName } from "@archestra/shared";
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
 * `include = ["mcp/*.toml"]`.
 *
 * Batteries are the include entries OpenAPPA's own composer answers. A
 * repository include is the host's: before composing, the host folds each
 * file's rules into the root, after the root's own and in include order, so
 * the root's rules for a tool still win and every battery comes after. A file
 * may set only what an OpenAPPA include may set: `[[policy.tool]]`,
 * `[[policy.annotator]]`, `[[policy.authority]]`, `[[policy.sanitizer]]`, and
 * the `confined_results` of tools it declares under `[policy.deployment]`.
 *
 * `mcp/<prefix>.toml` is one MCP server's own rules file, and `mcp/*.toml`
 * includes every one the commit holds, so a server's first file needs no line
 * of its own in `appa.toml`. Whatever review merged it, such a file reaches
 * only its own server: rules for that server's tools, annotators under its
 * name, and none of the helpers that serve every call. The files cannot
 * overlap, so their order does not matter. `<prefix>__*` is the server's own
 * catch-all: the host writes it out as one rule for each of the server's tools
 * the file has no rule of its own for, after the file's other rules.
 *
 * Archestra stores none of these files. They are read from the repository at
 * the commit Git sync accepted, so who may change one, and how, is the
 * repository's to decide: its pull requests, reviews and code owners.
 */

/** The `[policy]` arrays an included file may add to. */
const INCLUDABLE = ["tool", "annotator", "authority", "sanitizer"] as const;

type Includable = (typeof INCLUDABLE)[number];

/** The folder of the MCP servers' own rules files, beside `appa.toml`. */
export const SERVER_RULES_FOLDER = "mcp";

/**
 * The include entry for every server rules file the commit holds. It is
 * Archestra's spelling: OpenAPPA itself reads each include entry as one file.
 */
export const SERVER_RULES_INCLUDE = `${SERVER_RULES_FOLDER}/*.toml`;

/** A server rules file by its path, `mcp/<prefix>.toml`; no hidden file. */
const SERVER_RULES_FILE = /^mcp\/([^/.][^/]*)\.toml$/;

/** A tool prefix as Archestra writes one: a slugified server name. */
const SERVER_PREFIX = /^[a-z0-9_-]+$/;

/**
 * A repository-relative `.toml` path outside `batteries/`, with no `.` or
 * `..` segment, which the segment pattern rules out by refusing a leading dot.
 */
const REPOSITORY_INCLUDE =
  /^(?!batteries\/)(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.toml$/;

/** A quick test that a text could name one, so most texts skip the parse. */
const MAY_NAME_REPOSITORY_INCLUDE = /["'](?!batteries\/)[^"'\n]*\.toml["']/;

/** The most repository files one root may fold in, every server's counted. */
export const MAX_REPOSITORY_FILES = 512;

/**
 * Whether an `include` entry names a file in the policy repository, or every
 * server rules file at once.
 */
export function isRepositoryInclude(entry: string): boolean {
  return entry === SERVER_RULES_INCLUDE || REPOSITORY_INCLUDE.test(entry);
}

/** The file an MCP server's rules are kept in, by its tools' prefix. */
export function serverRulesPath(toolPrefix: string): string {
  return `${SERVER_RULES_FOLDER}/${toolPrefix}.toml`;
}

/** Whether a repository path is a server rules file `mcp/*.toml` takes in. */
export function isServerRulesFile(path: string): boolean {
  return SERVER_RULES_FILE.test(path);
}

/** The repository include entries a root document lists, in its order. */
export function repositoryIncludePaths(content: string): string[] {
  if (!MAY_NAME_REPOSITORY_INCLUDE.test(content)) return [];
  const include = parsePolicyToml(content)?.include;
  if (!Array.isArray(include)) return [];
  return include.filter(
    (entry): entry is string =>
      typeof entry === "string" && isRepositoryInclude(entry),
  );
}

/** Whether the root folds in this server rules file, by name or with all. */
export function includesServerRules(content: string, path: string): boolean {
  const entries = repositoryIncludePaths(content);
  return entries.includes(path) || entries.includes(SERVER_RULES_INCLUDE);
}

/** The identity of one included file's bytes, for fingerprints and views. */
export function repositoryFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Why `content` could not be an included file, or none. The same check the
 * fold makes, scope included, for a caller that refuses a file before any
 * review sees it.
 */
export function includedFileErrors(path: string, content: string): string[] {
  const parsed = parseIncluded(path, content);
  return "errors" in parsed ? parsed.errors : [];
}

/**
 * The root with every repository include folded in, or the root unchanged
 * when it includes none. `files` holds each included file's text by path,
 * and every server rules file the commit holds when the root includes them
 * all. `paths` lists the files folded in, in order. Comments in the root do
 * not survive a fold; the result is composition input, never stored or shown
 * as the policy text.
 */
export function expandRepositoryIncludes(params: {
  content: string;
  files: ReadonlyMap<string, string>;
  /** Each server's current tools by prefix, for the files' `<prefix>__*` rules. */
  serverTools?: ReadonlyMap<string, readonly string[]>;
}): {
  content: string;
  errors: string[];
  paths: string[];
  /** The tools each file's `<prefix>__*` rules were written out for, by path. */
  covered: Map<string, string[]>;
} {
  const entries = repositoryIncludePaths(params.content);
  const covered = new Map<string, string[]>();
  if (entries.length === 0)
    return { content: params.content, errors: [], paths: [], covered };
  // The text parsed above, so this is a table.
  const document = parsePolicyToml(params.content) as Record<string, unknown>;
  const errors: string[] = [];
  const duplicated = entries.filter(
    (entry, index) => entries.indexOf(entry) !== index,
  );
  for (const entry of new Set(duplicated))
    errors.push(`include: ${JSON.stringify(entry)} is included more than once`);
  const paths = includedPaths(entries, params.files);
  if (paths.length > MAX_REPOSITORY_FILES)
    errors.push(
      `include: ${paths.length} repository files are included; at most ${MAX_REPOSITORY_FILES} are allowed`,
    );
  const policy = asRecord(document.policy) ?? {};
  for (const kind of INCLUDABLE)
    if (policy[kind] !== undefined && !Array.isArray(policy[kind]))
      errors.push(
        `policy.${kind} must be written as [[policy.${kind}]] entries to include repository files`,
      );
  if (policy.deployment !== undefined && !asRecord(policy.deployment))
    errors.push(
      "policy.deployment must be a table to include repository files",
    );
  if (errors.length > 0)
    return { content: params.content, errors, paths: [], covered };

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
    const prefix = SERVER_RULES_FILE.exec(path)?.[1];
    if (prefix !== undefined && parsed.policy.tool) {
      const written = withServerCatchAll({
        prefix,
        rules: parsed.policy.tool,
        tools: params.serverTools?.get(prefix) ?? [],
      });
      parsed.policy.tool = written.rules;
      if (written.covered) covered.set(path, written.covered);
    }
    for (const kind of INCLUDABLE) {
      const added = parsed.policy[kind];
      if (!added) continue;
      // As in OpenAPPA, a helper the root declares under the same name
      // replaces an included one; rules for one tool all stay, root first.
      const kept =
        kind === "tool"
          ? added
          : added.filter((entry) => !rootHelpers[kind].has(nameOf(entry)));
      policy[kind] = [...((policy[kind] as unknown[]) ?? []), ...kept];
    }
    if (parsed.confined.length > 0) {
      // As in OpenAPPA, a file's confined tools join the root's list.
      const deployment = asRecord(policy.deployment) ?? {};
      const listed = Array.isArray(deployment.confined_results)
        ? deployment.confined_results
        : [];
      deployment.confined_results = [
        ...listed,
        ...parsed.confined.filter((name) => !listed.includes(name)),
      ];
      policy.deployment = deployment;
    }
  }
  if (errors.length > 0)
    return { content: params.content, errors, paths: [], covered };

  const include = (document.include as unknown[]).filter(
    (entry) => typeof entry !== "string" || !isRepositoryInclude(entry),
  );
  if (include.length > 0) document.include = include;
  else delete document.include;
  document.policy = policy;
  return { content: stringifyToml(document), errors: [], paths, covered };
}

/**
 * The server files among `files` whose rules include the server's own
 * catch-all, `<prefix>__*`, by prefix: the servers whose tools a fold needs.
 */
export function serverCatchAllPrefixes(
  files: ReadonlyMap<string, string>,
): string[] {
  const prefixes = new Set<string>();
  for (const [path, text] of files) {
    const prefix = SERVER_RULES_FILE.exec(path)?.[1];
    if (prefix === undefined || !text.includes(`${prefix}__*`)) continue;
    const rules = tablesOf(asRecord(parsePolicyToml(text)?.policy)?.tool);
    if (rules.some((rule) => isServerCatchAll(prefix, rule)))
      prefixes.add(prefix);
  }
  return [...prefixes].sort();
}

/** Whether a rule is `<prefix>__*`, with or without an argument selector. */
function isServerCatchAll(
  prefix: string,
  rule: Record<string, unknown>,
): boolean {
  return (
    typeof rule.name === "string" &&
    rule.server === undefined &&
    ruleTool(rule.name) === `${prefix}__*`
  );
}

/**
 * A server file's rules with its `<prefix>__*` rules written out: one copy of
 * each for every tool of the server the file has no plain rule for, after
 * the file's other rules, as OpenAPPA's catch-all comes after every contract.
 */
function withServerCatchAll(params: {
  prefix: string;
  rules: unknown[];
  tools: readonly string[];
}): { rules: unknown[]; covered?: string[] } {
  const { prefix } = params;
  const rules = tablesOf(params.rules);
  const catchAll = rules.filter((rule) => isServerCatchAll(prefix, rule));
  if (catchAll.length === 0) return { rules: params.rules };
  const own = rules.filter((rule) => !isServerCatchAll(prefix, rule));
  // A plain rule always matches its tool, so the catch-all never reaches it;
  // a rule with an argument selector leaves the tool's other calls to it.
  const ruled = new Set(
    own.flatMap((rule) =>
      typeof rule.name === "string" && !rule.name.includes("(")
        ? [rule.name]
        : [],
    ),
  );
  const covered = [...new Set(params.tools)]
    .filter(
      (tool) =>
        parseFullToolName(tool).serverName === prefix && !ruled.has(tool),
    )
    .sort();
  return {
    rules: [
      ...own,
      ...catchAll.flatMap((rule) =>
        covered.map((tool) => ({
          ...rule,
          name: `${tool}${(rule.name as string).slice(`${prefix}__*`.length)}`,
        })),
      ),
    ],
    covered,
  };
}

/** A rule name without its argument selector. */
function ruleTool(name: string): string {
  return name.split("(", 1)[0] ?? "";
}

/**
 * Whether one `[[policy.tool]]` entry names only tools of the MCP server with
 * this prefix: `<prefix>__<tool>`, the server's catch-all `<prefix>__*`,
 * `mcp/<prefix>/<tool>`, or a tool name with `server = "<prefix>"`. A bare
 * tool name matches across servers, and `*` matches every tool, so neither is
 * the server's own.
 */
export function governsServerTool(
  prefix: string,
  rule: Record<string, unknown>,
): boolean {
  if (typeof rule.name !== "string") return false;
  // A rule's argument selector narrows it; it never widens the tools it names.
  const bare = ruleTool(rule.name);
  if (bare === "" || bare === "*") return false;
  if (rule.server !== undefined)
    return rule.server === prefix && !bare.includes("/");
  const canonical = /^mcp\/([^/]+)\/[^/]+$/.exec(bare);
  if (canonical) return canonical[1] === prefix;
  // Split as the runtime splits a tool name: at its last separator.
  return parseFullToolName(bare).serverName === prefix;
}

/**
 * Every file the entries fold in, in order. `mcp/*.toml` stands for each
 * server rules file in `files` that the root does not name on its own, by name.
 */
function includedPaths(
  entries: readonly string[],
  files: ReadonlyMap<string, string>,
): string[] {
  const named = new Set(entries);
  return [...named].flatMap((entry) =>
    entry === SERVER_RULES_INCLUDE
      ? [...files.keys()]
          .filter((path) => isServerRulesFile(path) && !named.has(path))
          .sort()
      : [entry],
  );
}

function helperNames(entries: unknown): Set<string> {
  return new Set(Array.isArray(entries) ? entries.map(nameOf) : []);
}

function nameOf(entry: unknown): string {
  const name = asRecord(entry)?.name;
  return typeof name === "string" ? name : "";
}

function tablesOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const table = asRecord(entry);
        return table ? [table] : [];
      })
    : [];
}

type IncludedFile = {
  policy: Partial<Record<Includable, unknown[]>>;
  /** The tools it lists under `[policy.deployment] confined_results`. */
  confined: string[];
};

function parseIncluded(
  path: string,
  content: string,
  /** The root's `policy.version`, which an included file must state too. */
  version: unknown = 2,
): IncludedFile | { errors: string[] } {
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
    "may set only [policy] version, [[policy.tool]], [[policy.annotator]], [[policy.authority]], [[policy.sanitizer]] and [policy.deployment] confined_results";
  const extra = Object.keys(document).filter((key) => key !== "policy");
  if (extra.length > 0)
    return {
      errors: [
        `${path}: an included file ${allowed}; it sets ${extra.join(", ")}`,
      ],
    };
  const {
    version: stated,
    deployment,
    ...policy
  } = asRecord(document.policy) ?? {};
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
  const settings = asRecord(deployment);
  if (deployment !== undefined && !settings)
    errors.push(`${path}: write [policy.deployment] as a table`);
  for (const key of Object.keys(settings ?? {}))
    if (key !== "confined_results")
      errors.push(
        `${path}: an included file ${allowed}; it sets policy.deployment.${key}`,
      );
  const confined = settings?.confined_results ?? [];
  if (
    !Array.isArray(confined) ||
    confined.some((name) => typeof name !== "string")
  )
    errors.push(`${path}: list tool names in confined_results`);
  if (errors.length > 0) return { errors };

  // As in OpenAPPA, a file confines only results of tools it declares itself.
  const declared = new Set(tablesOf(policy.tool).map(nameOf));
  for (const name of confined as string[])
    if (!declared.has(name))
      errors.push(
        `${path}: confined_results may list only tools this file declares; ${JSON.stringify(name)} is not one`,
      );
  const prefix = SERVER_RULES_FILE.exec(path)?.[1];
  if (prefix !== undefined)
    errors.push(...serverScopeErrors(path, prefix, policy));
  if (errors.length > 0) return { errors };
  return {
    policy: policy as Partial<Record<Includable, unknown[]>>,
    confined: confined as string[],
  };
}

/**
 * What a server's own rules file sets outside that server. An authority or a
 * sanitizer serves every call its tags cover, not only this server's, so the
 * file declares neither: its rules reach the organization's own through
 * attention marks and tags.
 */
function serverScopeErrors(
  path: string,
  prefix: string,
  policy: Record<string, unknown>,
): string[] {
  if (!SERVER_PREFIX.test(prefix) || prefix.includes("__"))
    return [
      `${path}: ${SERVER_RULES_FOLDER}/ holds one file per MCP server, named by its tools' prefix; ${JSON.stringify(prefix)} is not one Archestra gives a server`,
    ];
  const outside = [
    ...tablesOf(policy.tool)
      .filter((rule) => !governsServerTool(prefix, rule))
      .map((rule) =>
        typeof rule.name !== "string"
          ? "a rule without a name"
          : rule.server === undefined
            ? rule.name
            : `${rule.name} on server ${JSON.stringify(rule.server)}`,
      ),
    ...tablesOf(policy.annotator)
      .map(nameOf)
      .filter((name) => !name.startsWith(`${prefix}.`))
      .map((name) => `annotator ${JSON.stringify(name)}`),
    ...(["authority", "sanitizer"] as const).flatMap((kind) =>
      tablesOf(policy[kind]).map(
        (entry) => `[[policy.${kind}]] ${nameOf(entry)}`,
      ),
    ),
  ];
  return outside.length === 0
    ? []
    : [
        `${path} may hold only rules for the tools of the MCP server it is named for (${prefix}__<tool>) and annotators named ${prefix}.<name>, and declares no authority or sanitizer; it sets ${outside.join(", ")}`,
      ];
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
