import { expect, test } from "vitest";
import {
  buildPolicyTree,
  type PolicyFile,
  type PolicyTreeNode,
  parsePolicyRules,
  policyIncludeLinks,
} from "./policy-files";

function file(path: string): PolicyFile {
  return {
    key: path,
    entry: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: "repository",
    label: path,
    disabled: false,
  };
}

/** The tree as indented names, a folder marked by its trailing slash. */
function outline(nodes: PolicyTreeNode[], depth = 0): string[] {
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
  const tree = buildPolicyTree([
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
  const tree = buildPolicyTree([
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

test("the outline lists tool rules by name and line, and nothing else that has a name", () => {
  const content = [
    "[battery]",
    'name = "github"',
    "",
    "[[policy.tool]]",
    "# Reads narrow the audience.",
    'name = "github__get_file"',
    'delta = { audience = ["internal"] }',
    "",
    "[[policy.authority]]",
    'name = "human-approval"',
    "",
    "  [[policy.tool]]",
    '  name = "github__push"',
  ].join("\n");
  expect(parsePolicyRules(content)).toEqual([
    { name: "github__get_file", line: 6 },
    { name: "github__push", line: 13 },
  ]);
});

test("include links cover only the paths of files that can be opened", () => {
  const content = [
    'title = "batteries/github.toml"',
    "include = [",
    '  "batteries/github.toml",',
    '  "mcp/*.toml",',
    '  "mcp/payments.toml", "shared/rules.toml"',
    "]",
    'note = "shared/rules.toml"',
  ].join("\n");
  const links = policyIncludeLinks(
    content,
    new Set([
      "batteries/github.toml",
      "mcp/payments.toml",
      "shared/rules.toml",
    ]),
  );
  expect(links).toEqual([
    { entry: "batteries/github.toml", line: 3, startColumn: 4, endColumn: 25 },
    { entry: "mcp/payments.toml", line: 5, startColumn: 4, endColumn: 21 },
    { entry: "shared/rules.toml", line: 5, startColumn: 25, endColumn: 42 },
  ]);
  // The columns bound exactly the path between its quotes.
  const lines = content.split("\n");
  for (const link of links)
    expect(
      lines[link.line - 1].slice(link.startColumn - 1, link.endColumn - 1),
    ).toBe(link.entry);
});

test("an include list written on one line links its paths", () => {
  expect(
    policyIncludeLinks('include = ["a.toml", "b.toml"]\n', new Set(["b.toml"])),
  ).toEqual([{ entry: "b.toml", line: 1, startColumn: 23, endColumn: 29 }]);
});
