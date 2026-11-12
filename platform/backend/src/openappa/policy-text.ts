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
 * name that no included battery declares too, and none of the helpers that
 * serve every call. The files cannot
 * overlap, so their order does not matter. `<prefix>__*` is the server's own
 * catch-all: the host writes it out as one rule for each of the server's tools
 * the file has no rule of its own for, after the file's other rules. Neither
 * `mcp/*.toml` nor the catch-all is OpenAPPA's own: only the host reads them.
 *
 * Archestra stores none of these files. They are read from the repository at
 * the commit Git sync accepted, so who may change one, and how, is the
 * repository's to decide: its pull requests and the policy check on them.
 */

/** The `[policy]` arrays an included file may add to. */
const INCLUDABLE = ["tool", "annotator", "authority", "sanitizer"] as const;

type Includable = (typeof INCLUDABLE)[number];

/**
 * The folder of the MCP servers' own rules files, beside `appa.toml`, unless
 * the Git sync source names another: its self-service folder.
 */
const DEFAULT_SERVER_RULES_FOLDER = "mcp";

/**
 * The include entry for every server rules file the commit holds: a folder
 * glob, as OpenAPPA 0.41 reads one, over the servers' folder.
 */
export function serverRulesInclude(folder: string): string {
  return `${folder}/*.toml`;
}

/**
 * Whether `folder` may hold the servers' files: a folder beside the policy
 * file, outside `batteries/`, with no `.` or `..` segment and no `*`.
 */
export function isServerRulesFolder(folder: string): boolean {
  return folder !== "" && REPOSITORY_FOLDER.test(`${folder}/`);
}

/** The folder of a self-service source, or the default for one without. */
export function serverRulesFolderOf(
  source: { selfServiceDirectory?: string | null } | null | undefined,
): string {
  return source?.selfServiceDirectory || DEFAULT_SERVER_RULES_FOLDER;
}

/**
 * An include entry that names every matching file in one folder, as OpenAPPA
 * reads one: only the file name holds `*`, which matches any run of
 * characters, and it ends in `.toml`. The matching files load at the entry's
 * position in name order, as if `include` listed each; a hidden file does
 * not match, nor does a file another entry names on its own, and two such
 * entries cannot match the same file. Null for an entry without `*`.
 * Throws for a glob OpenAPPA would refuse, naming why.
 */
export function parseIncludeGlob(
  entry: string,
): { folder: string; pattern: string } | null {
  if (!entry.includes("*")) return null;
  const slash = entry.lastIndexOf("/");
  const folder = slash < 0 ? "" : entry.slice(0, slash);
  const pattern = entry.slice(slash + 1);
  const refuse = (reason: string) => {
    throw new Error(
      `include: ${JSON.stringify(entry)} is not a valid glob: ${reason}`,
    );
  };
  if (folder.includes("*")) refuse("only the file name may hold `*`");
  if (!pattern.endsWith(".toml")) refuse("the file name must end in `.toml`");
  if (folder !== "" && !REPOSITORY_FOLDER.test(`${folder}/`))
    refuse(
      "the folder must be a folder beside the policy file, outside batteries/, with no `.` or `..` segment",
    );
  if (!GLOB_FILE_NAME.test(pattern))
    refuse("the file name holds a character a policy file name cannot");
  return { folder, pattern };
}

/** A folder segment list as a repository include may name, with its trailing slash. */
const REPOSITORY_FOLDER =
  /^(?!batteries\/)(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*$/;

/** A glob's file name: the characters a policy file name may hold, and `*`. */
const GLOB_FILE_NAME = /^[A-Za-z0-9_*-][A-Za-z0-9_.*-]*\.toml$/;

/**
 * Whether `name` matches a glob's file name, where `*` matches any run of
 * characters, including none, and every other character matches itself.
 */
export function globFileNameMatches(pattern: string, name: string): boolean {
  if (name.startsWith(".")) return false;
  const parts = pattern.split("*");
  const first = parts.shift() ?? "";
  if (!name.startsWith(first)) return false;
  let rest = name.slice(first.length);
  const last = parts.pop();
  if (last === undefined) return rest === "";
  for (const part of parts) {
    const at = rest.indexOf(part);
    if (at < 0) return false;
    rest = rest.slice(at + part.length);
  }
  return rest.length >= last.length && rest.endsWith(last);
}

/** Whether a glob entry names this file: same folder, matching name. */
function globNames(entry: string, path: string): boolean {
  let glob: ReturnType<typeof parseIncludeGlob>;
  try {
    glob = parseIncludeGlob(entry);
  } catch {
    return false;
  }
  if (!glob) return false;
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? "" : path.slice(0, slash);
  return (
    folder === glob.folder &&
    globFileNameMatches(glob.pattern, path.slice(slash + 1))
  );
}

/**
 * The tool prefix a server rules file in `folder` is named for, read from a
 * policy-relative path, `<folder>/<prefix>.toml`; null for another path, a
 * hidden file, or a file deeper down.
 */
function serverRulesFilePrefix(folder: string, path: string): string | null {
  if (!path.startsWith(`${folder}/`)) return null;
  const name = path.slice(folder.length + 1);
  if (!name.endsWith(".toml") || name.startsWith(".") || name.includes("/"))
    return null;
  const prefix = name.slice(0, -".toml".length);
  return prefix === "" ? null : prefix;
}

/** A tool prefix as Archestra writes one: a slugified server name. */
const SERVER_PREFIX = /^[a-z0-9_-]+$/;

/** Pull request branches this deployment opens for a server's rules. */
const SERVER_RULES_BRANCH = "archestra/openappa-server-";

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
 * matching file in one of its folders.
 */
export function isRepositoryInclude(entry: string): boolean {
  if (REPOSITORY_INCLUDE.test(entry)) return true;
  try {
    return parseIncludeGlob(entry) !== null;
  } catch {
    return false;
  }
}

/** The file an MCP server's rules are kept in, by its tools' prefix. */
export function serverRulesPath(folder: string, toolPrefix: string): string {
  return `${folder}/${toolPrefix}.toml`;
}

/** Whether a policy-relative path is a server rules file `<folder>/*.toml` takes in. */
export function isServerRulesFile(folder: string, path: string): boolean {
  return serverRulesFilePrefix(folder, path) !== null;
}

/** The tool prefix a server rules file is named for, or null for another path. */
export function serverRulesPrefix(folder: string, path: string): string | null {
  return serverRulesFilePrefix(folder, path);
}

/** The branch of a pull request this deployment opens for one server's rules. */
export function serverRulesBranch(toolPrefix: string, suffix: string): string {
  return `${SERVER_RULES_BRANCH}${toolPrefix}-${suffix}`;
}

/**
 * Whether a branch is one this deployment opened for a server's rules: for
 * the server with this tool prefix, or for any server when none is given.
 */
export function isServerRulesBranch(
  branch: string,
  toolPrefix?: string,
): boolean {
  if (!branch.startsWith(SERVER_RULES_BRANCH)) return false;
  const named = /^(.+)-[0-9a-f]{8}$/.exec(
    branch.slice(SERVER_RULES_BRANCH.length),
  )?.[1];
  if (named === undefined) return false;
  return toolPrefix === undefined
    ? SERVER_PREFIX.test(named)
    : named === toolPrefix;
}

/**
 * The root with `entry` added to its `include` list, through OpenAPPA's own
 * editor so the rest of the text keeps its shape; throws what it refuses.
 */
export async function withIncludeEntry(
  root: string,
  entry: string,
): Promise<string> {
  // A multi-line list gets the entry as a line of its own, as a person would
  // write it; OpenAPPA's editor appends it on the last entry's line.
  const lined = withIncludeLine(root, entry);
  if (lined !== null) return lined;
  const native = await import("@archestra/openappa-rs");
  const edited = await native.editOpenappaPolicy(root, [
    { kind: "addInclude", entry },
  ]);
  if (edited.content === undefined || edited.content === null)
    throw new Error(edited.errors.join("\n"));
  return edited.content;
}

/**
 * The root with `<folder>/*.toml` in its include list. A narrower glob over
 * the same folder, such as `mcp/a*.toml`, is replaced rather than joined:
 * OpenAPPA refuses a file two globs match, so the two could not stand
 * together once such a file exists. Two such entries are refused; that root
 * takes a person's edit.
 */
export async function withServerRulesFolderIncluded(
  root: string,
  folder: string,
): Promise<string> {
  const entry = serverRulesInclude(folder);
  const narrower = narrowerFolderGlobs(root, folder);
  if (narrower.length === 0) return withIncludeEntry(root, entry);
  const [only] = narrower;
  if (narrower.length === 1 && only !== undefined) {
    for (const literal of [JSON.stringify(only), `'${only}'`]) {
      if (root.split(literal).length !== 2) continue;
      const edited = root.replace(literal, JSON.stringify(entry));
      if (
        repositoryIncludePaths(edited).includes(entry) &&
        narrowerFolderGlobs(edited, folder).length === 0
      )
        return edited;
    }
  }
  throw new Error(
    `the policy already includes ${narrower
      .map((item) => JSON.stringify(item))
      .join(
        " and ",
      )}, which takes in only some of the files in ${folder}/; replace it with ${JSON.stringify(entry)} first`,
  );
}

/** The glob entries over `folder` other than its whole glob, `<folder>/*.toml`. */
function narrowerFolderGlobs(root: string, folder: string): string[] {
  const whole = serverRulesInclude(folder);
  return repositoryIncludePaths(root).filter((item) => {
    if (item === whole) return false;
    try {
      return parseIncludeGlob(item)?.folder === folder;
    } catch {
      return false;
    }
  });
}

/**
 * `entry` added as its own line at the end of a multi-line `include` list,
 * indented like the entry before it, or null when the root has no such list
 * or the edit did not read back as expected.
 */
function withIncludeLine(root: string, entry: string): string | null {
  const open = /^[ \t]*include[ \t]*=[ \t]*\[[ \t]*(?:#[^\n]*)?\n/m.exec(root);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = /^[ \t]*\]/m.exec(root.slice(start));
  if (!close) return null;
  const body = root.slice(start, start + close.index);
  const lines = body.split("\n");
  // The last entry line decides the indent and whether a comma is due.
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i]?.trim() ?? "";
    if (text !== "" && !text.startsWith("#")) {
      last = i;
      break;
    }
  }
  const indent =
    last < 0 ? "  " : (/^[ \t]*/.exec(lines[last] ?? "")?.[0] ?? "");
  if (last >= 0) {
    const line = lines[last] as string;
    const code = line.split("#")[0] as string;
    if (!/,\s*$/.test(code))
      lines[last] = line.replace(code, `${code.trimEnd()},`);
  }
  lines.splice(last + 1, 0, `${indent}${JSON.stringify(entry)},`);
  const edited =
    root.slice(0, start) + lines.join("\n") + root.slice(start + close.index);
  const include = parsePolicyToml(edited)?.include;
  return Array.isArray(include) && include.includes(entry) ? edited : null;
}

/**
 * Whether the root folds in every file of the servers' folder through the
 * one glob entry over it, `<folder>/*.toml`. A narrower entry, one file by
 * name or `mcp/a*.toml`, does not count: a server outside it would still
 * need a root change.
 */
export function includesServerRulesFolder(
  content: string,
  folder: string,
): boolean {
  return repositoryIncludePaths(content).includes(serverRulesInclude(folder));
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

/** Whether the root folds in this server rules file, by name or by a glob. */
export function includesServerRules(content: string, path: string): boolean {
  return repositoryIncludePaths(content).some(
    (entry) => entry === path || globNames(entry, path),
  );
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
export function includedFileErrors(
  path: string,
  content: string,
  folder: string = DEFAULT_SERVER_RULES_FOLDER,
): string[] {
  const parsed = parseIncluded(path, content, 2, folder);
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
  /**
   * The annotators the root's batteries declare, each with its battery. A
   * folded annotator is the root's, and a root's helper replaces a battery's
   * of the same name, so a server file may declare none of these.
   */
  batteryHelpers?: ReadonlyMap<string, string>;
  /** The servers' folder; a file there is held to its server. */
  serverRulesFolder?: string;
}): {
  content: string;
  errors: string[];
  paths: string[];
  /** The tools each file's `<prefix>__*` rules were written out for, by path. */
  covered: Map<string, string[]>;
} {
  const entries = repositoryIncludePaths(params.content);
  const covered = new Map<string, string[]>();
  const folder = params.serverRulesFolder ?? DEFAULT_SERVER_RULES_FOLDER;
  const malformed = malformedGlobs(params.content);
  if (entries.length === 0 && malformed.length === 0)
    return { content: params.content, errors: [], paths: [], covered };
  // The text parsed above, so this is a table.
  const document = parsePolicyToml(params.content) as Record<string, unknown>;
  const errors: string[] = [...malformed];
  const duplicated = entries.filter(
    (entry, index) => entries.indexOf(entry) !== index,
  );
  for (const entry of new Set(duplicated))
    errors.push(`include: ${JSON.stringify(entry)} is included more than once`);
  const { paths, twice } = includedPaths(entries, params.files);
  for (const path of twice)
    errors.push(
      `include: ${JSON.stringify(path)} matches more than one glob entry; a file loads at one entry only`,
    );
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
    const parsed = parseIncluded(path, text, policy.version, folder);
    if ("errors" in parsed) {
      errors.push(...parsed.errors);
      continue;
    }
    const prefix = serverRulesFilePrefix(folder, path) ?? undefined;
    const replaced =
      prefix === undefined
        ? []
        : tablesOf(parsed.policy.annotator).flatMap((annotator) => {
            const battery = params.batteryHelpers?.get(nameOf(annotator));
            return battery === undefined
              ? []
              : [
                  `${path}: the ${battery} battery also declares annotator ${JSON.stringify(nameOf(annotator))}, and a server file cannot replace a battery's annotator. Name it ${prefix}.<another name>.`,
                ];
          });
    if (replaced.length > 0) {
      errors.push(...replaced);
      continue;
    }
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
 * Whether a server file among `files` declares an annotator: only then does
 * a fold need the names of the batteries' annotators. Read from the parsed
 * file, as the fold reads it, since TOML can spell a key many ways.
 */
export function serverFilesDeclareAnnotators(
  files: ReadonlyMap<string, string>,
  folder: string = DEFAULT_SERVER_RULES_FOLDER,
): boolean {
  for (const [path, text] of files)
    if (
      isServerRulesFile(folder, path) &&
      tablesOf(asRecord(parsePolicyToml(text)?.policy)?.annotator).length > 0
    )
      return true;
  return false;
}

/**
 * The server files among `files` whose rules include the server's own
 * catch-all, `<prefix>__*`, by prefix: the servers whose tools a fold needs.
 */
export function serverCatchAllPrefixes(
  files: ReadonlyMap<string, string>,
  folder: string = DEFAULT_SERVER_RULES_FOLDER,
): string[] {
  const prefixes = new Set<string>();
  for (const [path, text] of files) {
    const prefix = serverRulesFilePrefix(folder, path);
    if (prefix === null) continue;
    // The parsed names, as the fold reads them: an escaped spelling counts.
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
 * Every file the entries fold in, in order. A glob entry stands for each
 * file in `files` it matches that the root does not name on its own, in
 * name order; `twice` lists the files two globs match, which OpenAPPA refuses.
 */
function includedPaths(
  entries: readonly string[],
  files: ReadonlyMap<string, string>,
): { paths: string[]; twice: string[] } {
  const named = new Set(entries.filter((entry) => !entry.includes("*")));
  const seen = new Set<string>();
  const twice: string[] = [];
  const paths = [...new Set(entries)].flatMap((entry) => {
    if (!entry.includes("*")) return [entry];
    const matched = [...files.keys()]
      .filter((path) => !named.has(path) && globNames(entry, path))
      .sort();
    for (const path of matched)
      if (seen.has(path)) twice.push(path);
      else seen.add(path);
    return matched.filter((path) => !twice.includes(path));
  });
  return { paths, twice: [...new Set(twice)] };
}

/** Why each `include` entry with `*` that OpenAPPA would refuse is refused. */
function malformedGlobs(content: string): string[] {
  if (!content.includes("*")) return [];
  const include = parsePolicyToml(content)?.include;
  if (!Array.isArray(include)) return [];
  return include.flatMap((entry) => {
    if (typeof entry !== "string" || !entry.includes("*")) return [];
    try {
      parseIncludeGlob(entry);
      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
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
  /** The servers' folder: a file there may set only its server's rules. */
  folder: string = DEFAULT_SERVER_RULES_FOLDER,
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
  // OpenAPPA refuses an included file without the policy version, so a file
  // the root names loads in the repository's own `appa` checks as it folds here.
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
  const prefix = serverRulesFilePrefix(folder, path);
  if (prefix !== null)
    errors.push(...serverScopeErrors(path, folder, prefix, policy));
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
  folder: string,
  prefix: string,
  policy: Record<string, unknown>,
): string[] {
  if (!SERVER_PREFIX.test(prefix) || prefix.includes("__"))
    return [
      `${path}: ${folder}/ holds one file per MCP server, named by its tools' prefix; ${JSON.stringify(prefix)} is not a tool prefix`,
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

// =============================================================================
// Who asked: the trailer Archestra writes into the commits it makes
// =============================================================================

/**
 * The trailer a commit Archestra makes for a person carries. GitHub signs a
 * commit the App makes through its API only while the App is its author and
 * committer, so the person who asked is named in the message, which the
 * signature covers, and never as the git author.
 */
const REQUESTED_BY_TRAILER = "Requested-by";

/** A commit message with the requester's trailer. */
export function withRequester(message: string, email: string): string {
  return `${message.trimEnd()}\n\n${REQUESTED_BY_TRAILER}: ${email}`;
}

/** The one requester a commit message names, lowercased; null for none or several. */
export function requesterOf(message: string | undefined | null): string | null {
  const emails = new Set<string>();
  for (const line of (message ?? "").split("\n")) {
    const match = /^Requested-by:\s*(\S+@\S+)\s*$/i.exec(line.trim());
    if (match?.[1]) emails.add(match[1].toLowerCase());
  }
  const [email] = [...emails];
  return emails.size === 1 && email ? email : null;
}
