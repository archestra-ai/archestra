import { expect, test } from "vitest";
import {
  buildFileTree,
  type FileTreeNode,
  type WorkspaceFile,
} from "./file-tree";

function file(path: string): WorkspaceFile {
  return { key: path, path, name: path.slice(path.lastIndexOf("/") + 1) };
}

/** The tree as indented names, a folder marked by its trailing slash. */
function outline(nodes: FileTreeNode<WorkspaceFile>[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.type === "dir"
      ? [
          `${"  ".repeat(depth)}${node.name}/`,
          ...outline(node.children, depth + 1),
        ]
      : [`${"  ".repeat(depth)}${node.name}`],
  );
}

test("files nest in their folders, folders first, each level alphabetical", () => {
  const tree = buildFileTree([
    file("shared/rules.toml"),
    file("top.toml"),
    file("mcp/payments.toml"),
    file("mcp/billing.toml"),
  ]);
  expect(outline(tree)).toEqual([
    "mcp/",
    "  billing.toml",
    "  payments.toml",
    "shared/",
    "  rules.toml",
    "top.toml",
  ]);
});

test("a folder holding only one folder merges with it, and stops where files begin", () => {
  const tree = buildFileTree([
    file("teams/platform/production/deploys.toml"),
    file("teams/platform/production/databases.toml"),
    file("teams/platform/break-glass.toml"),
  ]);
  expect(outline(tree)).toEqual([
    "teams/platform/",
    "  production/",
    "    databases.toml",
    "    deploys.toml",
    "  break-glass.toml",
  ]);
  // The merged folder keeps the deepest path, so its key stays unique.
  expect(tree[0]).toMatchObject({ type: "dir", path: "teams/platform" });
});

test("an empty folder is listed among the others before it holds a file", () => {
  const tree = buildFileTree(
    [file("SKILL.md"), file("references/api.md")],
    ["scripts"],
  );
  expect(outline(tree)).toEqual([
    "references/",
    "  api.md",
    "scripts/",
    "SKILL.md",
  ]);
});
