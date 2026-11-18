import type { EnforcedStatus } from "./battery-status";

/**
 * One file the Policy page lists: the organization's text, a battery, a file
 * the organization policy includes from its repository, or a validation.
 */
export type PolicyFile = {
  /** "root" for the organization policy, else the include entry. */
  key: string;
  /** The include entry the URL's `entry` carries; null for the organization policy. */
  entry: string | null;
  /** Repository-style path, such as "batteries/archestra/github.toml". */
  path: string;
  /** The path's last segment. */
  name: string;
  kind: "root" | "battery" | "repository" | "validation";
  /** "Organization policy", a battery's display name, or the file's path. */
  label: string;
  /** Batteries only: how the enforced composition holds it. */
  status?: EnforcedStatus;
  statusLabel?: string;
  severity?: "ok" | "warning" | "critical";
  /** A repository file in the self-service folder holds an MCP server's rules. */
  mcpServerRules?: boolean;
  /**
   * For a reader of MCP servers' rules alone: the servers this file governs
   * that they may open, and whether they may change it from the registry.
   */
  servers?: { id: string; name: string }[];
  canEdit?: boolean;
  /** Batteries only: the battery's name, as its settings know it. */
  batteryName?: string;
  /** Validations only: what the newest run that replayed the file decided. */
  validation?: {
    status: "passed" | "failed" | "cannot_run" | "not_run";
    /** The name its author gave it: its first comment line. */
    title: string;
  };
  /** A battery whose package is missing has no source to open. */
  disabled: boolean;
};

/** The name of each `[[policy.tool]]` rule, with the line its name is on. */
export function parsePolicyRules(
  content: string,
): { name: string; line: number }[] {
  const rules: { name: string; line: number }[] = [];
  let inRule = false;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    if (/^\s*\[/.test(text)) {
      inRule = /^\s*\[\[policy\.tool\]\]/.test(text);
      continue;
    }
    if (!inRule) continue;
    const match = /^\s*name\s*=\s*"([^"]*)"/.exec(text);
    if (match) {
      rules.push({ name: match[1], line: index + 1 });
      inRule = false;
    }
  }
  return rules;
}

/**
 * Where the root's `include` list names a file that can be opened: the line
 * and the columns of the path between its quotes, both 1-based, the end
 * column exclusive.
 */
export function policyIncludeLinks(
  content: string,
  entries: ReadonlySet<string>,
): { entry: string; line: number; startColumn: number; endColumn: number }[] {
  const links: {
    entry: string;
    line: number;
    startColumn: number;
    endColumn: number;
  }[] = [];
  let inInclude = false;
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    if (!inInclude) {
      if (!/^\s*include\s*=\s*\[/.test(text)) continue;
      inInclude = true;
    }
    for (const match of text.matchAll(/"([^"]+)"/g)) {
      if (!entries.has(match[1])) continue;
      const startColumn = match.index + 2;
      links.push({
        entry: match[1],
        line: index + 1,
        startColumn,
        endColumn: startColumn + match[1].length,
      });
    }
    if (text.includes("]")) break;
  }
  return links;
}
