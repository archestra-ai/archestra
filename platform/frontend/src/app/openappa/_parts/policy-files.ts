import type { EnforcedStatus } from "./battery-status";

/** One file of the policy: the organization's text, a battery, or a repository file. */
export type PolicyFile = {
  /** "root" for the organization policy, else the include entry. */
  key: string;
  /** The include entry the URL's `entry` carries; null for the organization policy. */
  entry: string | null;
  /** Repository-style path, such as "batteries/archestra/github.toml". */
  path: string;
  /** The path's last segment. */
  name: string;
  kind: "root" | "battery" | "repository";
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
  /** A battery whose package is missing has no source to open. */
  disabled: boolean;
};

export type PolicyTreeNode =
  | { type: "dir"; name: string; path: string; children: PolicyTreeNode[] }
  | { type: "file"; name: string; path: string; file: PolicyFile };

/**
 * The files as folders: folders first, then files, each alphabetical. A folder
 * whose only child is a folder merges with it ("batteries/archestra"), as an
 * IDE's compact folders do.
 */
export function buildPolicyTree(files: PolicyFile[]): PolicyTreeNode[] {
  const top: PolicyTreeNode[] = [];
  for (const file of files) {
    let level = top;
    let prefix = "";
    for (const segment of file.path.split("/").slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let dir = level.find(
        (node): node is Extract<PolicyTreeNode, { type: "dir" }> =>
          node.type === "dir" && node.name === segment,
      );
      if (!dir) {
        dir = { type: "dir", name: segment, path: prefix, children: [] };
        level.push(dir);
      }
      level = dir.children;
    }
    level.push({ type: "file", name: file.name, path: file.path, file });
  }
  return compact(sort(top));
}

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

function sort(nodes: PolicyTreeNode[]): PolicyTreeNode[] {
  return nodes
    .map((node) =>
      node.type === "dir" ? { ...node, children: sort(node.children) } : node,
    )
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function compact(nodes: PolicyTreeNode[]): PolicyTreeNode[] {
  return nodes.map((node) => {
    if (node.type === "file") return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0].type === "dir") {
      const only = dir.children[0];
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: compact(dir.children) };
  });
}
