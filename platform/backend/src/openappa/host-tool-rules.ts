import { stringify as stringifyToml } from "smol-toml";
import logger from "@/logging";
import { asRecord, parsePolicyToml, toolEntries } from "./policy-text";

/**
 * The composed document with an empty rule for each tool the host itself
 * serves, unless a rule already names it.
 *
 * - `mcp/appa/yell`: the runtime rules a proxied `yell` under a name no
 *   battery declares. Without its own rule, `yell` falls to the catch-all: an
 *   annotator there must answer before the report runs, and a policy with no
 *   catch-all refuses it. `yell` is how a stuck session reaches a person.
 * - `mcp/<server>/read_peer_message`, under the deployment's (possibly
 *   white-labeled) server name: the runtime admits a peer read only through an
 *   exact rule with an empty `delta`, so the reader receives the message under
 *   the label its sender captured.
 *
 * The rules are part of the composition, so every process dispatches the same
 * bytes for it. A rule the organization wrote stands. When the runtime refuses
 * an added rule, the composition is kept without it.
 */
export async function withHostToolRules(params: {
  composed: string;
  serverName: string;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  let text = params.composed;
  // Yell comes last, so it is prepended last and stays the document's first rule.
  for (const tool of [
    `mcp/${params.serverName}/read_peer_message`,
    "mcp/appa/yell",
  ]) {
    text = await withEmptyRule({
      composed: text,
      tool,
      validate: params.validate,
    });
  }
  return text;
}

/**
 * The root document with any missing `[aliases.tool.coding]` targets for
 * supported client built-ins (`host/archestra/<name>`) filled in before
 * composition, when the deployment composes an active `coding` battery and
 * binds `claude-code` onto `"archestra"`.
 *
 * Organizations that saved a policy revision before a new client or client tool
 * spelling shipped still govern client built-ins through `coding` +
 * `claude-code`, without rewriting their stored `organization.appa.toml`. Any
 * target name the root or an included battery already maps is left untouched,
 * and explicit root `[[policy.tool]]` rules still take precedence over the
 * battery rules these aliases bind.
 */
export function withHostClientCodingAliases(params: {
  root: string;
  batteries: ReadonlyArray<{ name: string; policy: string }>;
}): string {
  const codingActive = params.batteries.some(
    (battery) =>
      battery.name === CODING_BATTERY && toolEntries(battery.policy).length > 0,
  );
  if (!codingActive) return params.root;

  const document = parsePolicyToml(params.root);
  if (!document) return params.root;

  const aliases = asRecord(document.aliases);
  const hostAliases = asRecord(aliases?.host);
  const claudeCodeHosts = hostAliases?.[CLAUDE_CODE_BATTERY];
  if (
    !Array.isArray(claudeCodeHosts) ||
    !claudeCodeHosts.includes(ARCHESTRA_HOST_TARGET)
  ) {
    return params.root;
  }

  const mapped = mappedToolNames(document, hostAliases, params.batteries);
  const additions = Object.entries(HOST_CLIENT_CODING_ALIASES)
    .map(
      ([canonical, targets]) =>
        [
          canonical,
          targets.filter((target) => !mapped.has(target.name)),
        ] as const,
    )
    .filter(([, missing]) => missing.length > 0);
  if (additions.length === 0) return params.root;

  const nextAliases = aliases ?? {};
  document.aliases = nextAliases;
  const toolAliases = asRecord(nextAliases.tool) ?? {};
  if (nextAliases.tool !== undefined && !asRecord(nextAliases.tool))
    return params.root;
  nextAliases.tool = toolAliases;
  const codingAliases = asRecord(toolAliases[CODING_BATTERY]) ?? {};
  if (
    toolAliases[CODING_BATTERY] !== undefined &&
    !asRecord(toolAliases[CODING_BATTERY])
  ) {
    return params.root;
  }
  toolAliases[CODING_BATTERY] = codingAliases;

  for (const [canonical, missing] of additions) {
    const current = codingAliases[canonical];
    if (current !== undefined && !Array.isArray(current)) return params.root;
    codingAliases[canonical] = [
      ...(Array.isArray(current) ? current : []),
      ...missing.map(toTomlAliasEntry),
    ];
  }
  return stringifyToml(document);
}

/**
 * Renders `[aliases.tool.coding]` for `initialPolicy()`, from the same target
 * table `withHostClientCodingAliases` supplies to earlier saved revisions.
 */
export function formatHostClientCodingAliases(): string {
  const lines = [`[aliases.tool.${CODING_BATTERY}]`];
  for (const [canonical, targets] of Object.entries(
    HOST_CLIENT_CODING_ALIASES,
  )) {
    if (targets.length === 1) {
      lines.push(`${canonical} = [${formatInlineAliasEntry(targets[0])}]`);
      continue;
    }
    lines.push(`${canonical} = [`);
    for (const target of targets) {
      lines.push(`  ${formatInlineAliasEntry(target)},`);
    }
    lines.push("]");
  }
  return lines.join("\n");
}

// ===

const CODING_BATTERY = "coding";
const CLAUDE_CODE_BATTERY = "claude-code";
const ARCHESTRA_HOST_TARGET = "archestra";

type HostCodingToolAlias = {
  readonly name: string;
  readonly args?: Readonly<Record<string, string>>;
  readonly confined?: boolean;
};

const HOST_CLIENT_CODING_ALIASES: Readonly<
  Record<string, readonly HostCodingToolAlias[]>
> = {
  shell: [
    { name: "host/archestra/exec_command", args: { command: "cmd" } },
    { name: "host/archestra/shell", args: { command: "command" } },
    { name: "host/archestra/bash", args: { command: "command" } },
    {
      name: "host/archestra/mcp__workspace__bash",
      args: { command: "command" },
      confined: true,
    },
  ],
  read_file: [
    { name: "host/archestra/read", args: { file_path: "filePath" } },
    { name: "host/archestra/read_file", args: { file_path: "target_file" } },
    { name: "host/archestra/view", args: { file_path: "path" } },
  ],
  search_files: [{ name: "host/archestra/grep", args: { path: "path" } }],
  write_file: [
    { name: "host/archestra/write", args: { file_path: "filePath" } },
    { name: "host/archestra/create", args: { file_path: "path" } },
  ],
  edit_file: [{ name: "host/archestra/edit", args: { file_path: "filePath" } }],
  fetch_url: [
    { name: "host/archestra/webfetch", args: { url: "url" } },
    {
      name: "host/archestra/mcp__workspace__web_fetch",
      args: { url: "url" },
    },
    { name: "host/archestra/FetchURL", args: { url: "url" } },
    { name: "host/archestra/web_fetch", args: { url: "url" } },
  ],
};

function mappedToolNames(
  rootDocument: Record<string, unknown>,
  hostAliases: Record<string, unknown> | null,
  batteries: ReadonlyArray<{ name: string; policy: string }>,
): Set<string> {
  const mapped = new Set<string>();
  collectToolAliasNames(asRecord(asRecord(rootDocument.aliases)?.tool), (raw) =>
    mapped.add(raw),
  );
  for (const battery of batteries) {
    const parsed = parsePolicyToml(battery.policy);
    collectToolAliasNames(asRecord(asRecord(parsed?.aliases)?.tool), (raw) => {
      mapped.add(raw);
      const hostMatch = /^host\/([^/]+)\/(.+)$/.exec(raw);
      if (!hostMatch) return;
      const [, sourceHost, tool] = hostMatch;
      const targets = hostAliases?.[sourceHost];
      if (!Array.isArray(targets)) return;
      for (const target of targets) {
        if (typeof target === "string") mapped.add(`host/${target}/${tool}`);
      }
    });
  }
  return mapped;
}

function collectToolAliasNames(
  toolAliases: Record<string, unknown> | null,
  visit: (name: string) => void,
): void {
  if (!toolAliases) return;
  for (const namespaceTable of Object.values(toolAliases)) {
    const record = asRecord(namespaceTable);
    if (!record) continue;
    for (const entries of Object.values(record)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === "string") {
          visit(entry);
          continue;
        }
        const name = asRecord(entry)?.name;
        if (typeof name === "string") visit(name);
      }
    }
  }
}

function toTomlAliasEntry(entry: HostCodingToolAlias): Record<string, unknown> {
  return {
    name: entry.name,
    ...(entry.args ? { args: { ...entry.args } } : {}),
    ...(entry.confined !== undefined ? { confined: entry.confined } : {}),
  };
}

function formatInlineAliasEntry(entry: HostCodingToolAlias): string {
  const fields = [`name = ${JSON.stringify(entry.name)}`];
  if (entry.args) {
    const args = Object.entries(entry.args)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join(", ");
    fields.push(`args = { ${args} }`);
  }
  if (entry.confined !== undefined) {
    fields.push(`confined = ${entry.confined}`);
  }
  return `{ ${fields.join(", ")} }`;
}

async function withEmptyRule(params: {
  composed: string;
  tool: string;
  validate: (text: string) => Promise<string[]>;
}): Promise<string> {
  const { composed, tool } = params;
  if (toolEntries(composed).some((entry) => entry.name === tool))
    return composed;
  const document = parsePolicyToml(composed);
  const policy = asRecord(document?.policy);
  if (!document || !policy) return composed;
  // An exact name beats the catch-all wherever it is declared; first, it would
  // also win under a resolver that took the first match.
  policy.tool = [
    { name: tool, delta: {} },
    ...(Array.isArray(policy.tool) ? policy.tool : []),
  ];
  const text = stringifyToml(document);
  const errors = await params.validate(text);
  if (errors.length === 0) return text;
  logger.warn(
    { errors, tool },
    "OpenAPPA refused an empty host tool rule; the composition keeps no rule for it",
  );
  return composed;
}
