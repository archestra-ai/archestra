import { expect, test } from "vitest";
import { parsePolicyRules, policyIncludeLinks } from "./policy-files";

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
