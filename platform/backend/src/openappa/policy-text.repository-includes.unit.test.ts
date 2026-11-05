import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import {
  expandRepositoryIncludes,
  includedFileErrors,
  isRepositoryInclude,
  repositoryIncludePaths,
  serverRulesPath,
  withoutRepositoryIncludes,
} from "./policy-text";

const ROOT = `include = [
  "batteries/archestra/appa.toml",
  "mcp/payments_api.toml",
  "mcp/helpdesk.toml",
]

[policy]
version = 2

# The organization's own rule for a payments tool.
[[policy.tool]]
name = "payments_api__export_ledger"
delta = { audience = ["self"] }

[[policy.tool]]
name = "*"
annotator = "archestra.llm-annotator"
`;

const PAYMENTS = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__refund_payment"
requires = { trust = "trusted" }

[[policy.tool]]
name = "payments_api__export_ledger"
delta = {}

[[policy.annotator]]
name = "payments_api.refund-check"
builtin = "archestra"
`;

const HELPDESK = `[policy]
version = 2

[[policy.tool]]
name = "helpdesk__read_ticket"
delta = { trust = "suspicious" }
`;

function files(entries: Record<string, string>) {
  return new Map(Object.entries(entries));
}

describe("repository includes", () => {
  test("a root that includes no repository file is returned byte for byte", () => {
    const root = `include = ["batteries/archestra/appa.toml"]\n# kept\n[policy]\nversion = 2\n`;
    expect(
      expandRepositoryIncludes({ content: root, files: files({}) }),
    ).toEqual({ content: root, errors: [] });
    expect(withoutRepositoryIncludes(root)).toBe(root);
  });

  test("each file's rules follow the root's own, in include order, and only batteries stay included", () => {
    const expanded = expandRepositoryIncludes({
      content: ROOT,
      files: files({
        "mcp/payments_api.toml": PAYMENTS,
        "mcp/helpdesk.toml": HELPDESK,
      }),
    });
    expect(expanded.errors).toEqual([]);
    const document = parse(expanded.content) as {
      include: string[];
      policy: {
        tool: Array<{ name: string }>;
        annotator: Array<{ name: string }>;
      };
    };
    expect(document.include).toEqual(["batteries/archestra/appa.toml"]);
    // The root's rule for export_ledger stays ahead of the file's, so it wins.
    expect(document.policy.tool.map((tool) => tool.name)).toEqual([
      "payments_api__export_ledger",
      "*",
      "payments_api__refund_payment",
      "payments_api__export_ledger",
      "helpdesk__read_ticket",
    ]);
    expect(document.policy.annotator.map((entry) => entry.name)).toEqual([
      "payments_api.refund-check",
    ]);
  });

  test("a file may add only rules, annotators, authorities and sanitizers", () => {
    for (const [text, sets] of [
      ["[externals]\ntimeout_ms = 1\n", "externals"],
      ['[aliases.mcp]\ngithub = ["payments_api"]\n', "aliases"],
      ["[policy.deployment]\ncontext_control = false\n", "policy.deployment"],
      ['include = ["mcp/other.toml"]\n', "include"],
    ] as const) {
      const expanded = expandRepositoryIncludes({
        content: ROOT,
        files: files({
          "mcp/payments_api.toml": `${text}[policy]\nversion = 2\n`,
          "mcp/helpdesk.toml": HELPDESK,
        }),
      });
      expect(expanded.content).toBe(ROOT);
      expect(expanded.errors).toEqual([
        expect.stringMatching(
          new RegExp(
            `^mcp/payments_api\\.toml: .*it sets ${sets.replace(".", "\\.")}$`,
          ),
        ),
      ]);
      expect(
        includedFileErrors(
          "mcp/payments_api.toml",
          `${text}[policy]\nversion = 2\n`,
        ),
      ).toEqual(expanded.errors);
    }
  });

  test("a file states the root's policy version, and the root's own helper wins over a file's", () => {
    expect(
      includedFileErrors(
        "mcp/helpdesk.toml",
        HELPDESK.replace("[policy]\nversion = 2\n\n", ""),
      ),
    ).toEqual([
      "mcp/helpdesk.toml: start the file with [policy] version = 2, as appa.toml does",
    ]);
    const root = `include = ["mcp/payments_api.toml"]

[policy]
version = 2

[[policy.annotator]]
name = "payments_api.refund-check"
builtin = "archestra"
hint = "the root's"
`;
    const document = parse(
      expandRepositoryIncludes({
        content: root,
        files: files({ "mcp/payments_api.toml": PAYMENTS }),
      }).content,
    ) as {
      policy: { version: number; annotator: Array<{ hint?: string }> };
    };
    expect(document.policy.version).toBe(2);
    expect(document.policy.annotator).toEqual([
      expect.objectContaining({ hint: "the root's" }),
    ]);
  });

  test("a missing, unparsable or twice-included file refuses the fold", () => {
    expect(
      expandRepositoryIncludes({
        content: ROOT,
        files: files({ "mcp/payments_api.toml": PAYMENTS }),
      }).errors,
    ).toEqual([
      'include: "mcp/helpdesk.toml" names no file in the policy repository at this commit',
    ]);
    expect(
      expandRepositoryIncludes({
        content: ROOT,
        files: files({
          "mcp/payments_api.toml": "[[policy.tool]\n",
          "mcp/helpdesk.toml": HELPDESK,
        }),
      }).errors,
    ).toEqual([
      expect.stringMatching(/^mcp\/payments_api\.toml: not valid TOML/),
    ]);
    const twice = `include = ["mcp/helpdesk.toml", "mcp/helpdesk.toml"]\n[policy]\nversion = 2\n`;
    expect(
      expandRepositoryIncludes({
        content: twice,
        files: files({ "mcp/helpdesk.toml": HELPDESK }),
      }).errors,
    ).toEqual(['include: "mcp/helpdesk.toml" is included more than once']);
  });

  test("only repository-relative .toml paths outside batteries/ are repository includes", () => {
    for (const entry of [
      "mcp/payments_api.toml",
      "teams/payments/rules.toml",
      "rules.toml",
    ])
      expect(isRepositoryInclude(entry)).toBe(true);
    for (const entry of [
      "batteries/github/appa.toml",
      "batteries/notes@sha256-1111/appa.toml",
      "../mcp/x.toml",
      "mcp/../x.toml",
      "/etc/x.toml",
      "mcp/.hidden.toml",
      "mcp/x.json",
    ])
      expect(isRepositoryInclude(entry)).toBe(false);
    expect(serverRulesPath("payments_api")).toBe("mcp/payments_api.toml");
    expect(repositoryIncludePaths(ROOT)).toEqual([
      "mcp/payments_api.toml",
      "mcp/helpdesk.toml",
    ]);
    expect(
      parse(withoutRepositoryIncludes(ROOT)) as { include: string[] },
    ).toMatchObject({ include: ["batteries/archestra/appa.toml"] });
  });
});
