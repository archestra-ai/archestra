import { parse } from "smol-toml";
import { describe, expect, test } from "vitest";
import {
  expandRepositoryIncludes,
  governsServerTool,
  includedFileErrors,
  includesServerRules,
  includesServerRulesFolder,
  isRepositoryInclude,
  repositoryIncludePaths,
  serverCatchAllPrefixes,
  serverFilesDeclareAnnotators,
  serverRulesPath,
  withIncludeEntry,
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
    ).toEqual({ content: root, errors: [], paths: [], covered: new Map() });
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
      [
        "[policy.deployment]\ncontext_control = false\n",
        "policy.deployment.context_control",
      ],
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
            `^mcp/payments_api\\.toml: .*it sets ${sets.replaceAll(".", "\\.")}$`,
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
    expect(isRepositoryInclude("mcp/*.toml")).toBe(true);
    expect(isRepositoryInclude("teams/*.toml")).toBe(true);
    expect(isRepositoryInclude("teams/*/rules.toml")).toBe(false);
    expect(serverRulesPath("mcp", "payments_api")).toBe(
      "mcp/payments_api.toml",
    );
    expect(serverRulesPath("rules/servers", "payments_api")).toBe(
      "rules/servers/payments_api.toml",
    );
    expect(repositoryIncludePaths(ROOT)).toEqual([
      "mcp/payments_api.toml",
      "mcp/helpdesk.toml",
    ]);
    expect(
      parse(withoutRepositoryIncludes(ROOT)) as { include: string[] },
    ).toMatchObject({ include: ["batteries/archestra/appa.toml"] });
  });

  test("mcp/*.toml folds in every server's file by name, after any the root names itself, and confines what each file lists", () => {
    const root = `include = ["batteries/archestra/appa.toml", "mcp/helpdesk.toml", "mcp/*.toml"]
[policy]
version = 2

[policy.deployment]
confined_results = ["github__get_file"]

[[policy.tool]]
name = "github__get_file"
delta = {}
`;
    const crm = `[policy]
version = 2

[[policy.tool]]
name = "crm__read_contact"
tags = ["support"]
delta = { audience = ["internal"] }

[policy.deployment]
confined_results = ["crm__read_contact"]
`;
    const expanded = expandRepositoryIncludes({
      content: root,
      files: files({
        "mcp/payments_api.toml": PAYMENTS,
        "mcp/helpdesk.toml": HELPDESK,
        "mcp/crm.toml": crm,
        // Not server rules files: a nested folder, another folder.
        "mcp/drafts/x.toml": "not read",
        "teams/support.toml": "not read",
      }),
    });
    expect(expanded.errors).toEqual([]);
    expect(expanded.paths).toEqual([
      "mcp/helpdesk.toml",
      "mcp/crm.toml",
      "mcp/payments_api.toml",
    ]);
    const document = parse(expanded.content) as {
      include: string[];
      policy: {
        deployment: { confined_results: string[] };
        tool: Array<{ name: string }>;
      };
    };
    expect(document.include).toEqual(["batteries/archestra/appa.toml"]);
    expect(document.policy.tool.map((tool) => tool.name)).toEqual([
      "github__get_file",
      "helpdesk__read_ticket",
      "crm__read_contact",
      "payments_api__refund_payment",
      "payments_api__export_ledger",
    ]);
    expect(document.policy.deployment.confined_results).toEqual([
      "github__get_file",
      "crm__read_contact",
    ]);
    expect(includesServerRules(root, "mcp/crm.toml")).toBe(true);
    expect(includesServerRules(ROOT, "mcp/crm.toml")).toBe(false);
    expect(
      expandRepositoryIncludes({ content: root, files: files({}) }).errors,
    ).toEqual([
      'include: "mcp/helpdesk.toml" names no file in the policy repository at this commit',
    ]);
  });

  test("any folder glob folds in the matching files in name order, once, as OpenAPPA reads one; a malformed glob or a file two globs match refuses the fold", () => {
    const root = `include = ["batteries/archestra/appa.toml", "teams/payments.toml", "teams/*.toml", "policies/ops-*.toml", "mcp/*.toml"]
[policy]
version = 2
`;
    const rule = (name: string) =>
      `[policy]\nversion = 2\n\n[[policy.tool]]\nname = "${name}"\ndelta = {}\n`;
    const expanded = expandRepositoryIncludes({
      content: root,
      files: files({
        // Named on its own: loads at its entry, not again through the glob.
        "teams/payments.toml": rule("payments_api__refund_payment"),
        "teams/support.toml": rule("helpdesk__read_ticket"),
        "teams/data.toml": rule("warehouse__query"),
        // Not matched: a hidden file, a nested folder, another pattern.
        "teams/.draft.toml": "not read",
        "teams/archive/old.toml": "not read",
        "policies/ops-shell.toml": rule("shell__run"),
        "policies/dev-shell.toml": "not read",
        "mcp/crm.toml": rule("crm__read_contact"),
      }),
    });
    expect(expanded.errors).toEqual([]);
    expect(expanded.paths).toEqual([
      "teams/payments.toml",
      "teams/data.toml",
      "teams/support.toml",
      "policies/ops-shell.toml",
      "mcp/crm.toml",
    ]);
    const document = parse(expanded.content) as {
      include: string[];
      policy: { tool: Array<{ name: string }> };
    };
    expect(document.include).toEqual(["batteries/archestra/appa.toml"]);
    expect(document.policy.tool.map((tool) => tool.name)).toEqual([
      "payments_api__refund_payment",
      "warehouse__query",
      "helpdesk__read_ticket",
      "shell__run",
      "crm__read_contact",
    ]);
    // A server file is included through any glob that names it.
    expect(
      includesServerRules(
        'include = ["mcp/pay*.toml"]',
        "mcp/payments_api.toml",
      ),
    ).toBe(true);
    expect(
      includesServerRules('include = ["mcp/pay*.toml"]', "mcp/crm.toml"),
    ).toBe(false);
    expect(isRepositoryInclude("teams/*.toml")).toBe(true);
    expect(isRepositoryInclude("*.toml")).toBe(true);
    expect(isRepositoryInclude("teams/*/rules.toml")).toBe(false);
    expect(isRepositoryInclude("batteries/*.toml")).toBe(false);
    // What OpenAPPA refuses, refused here with its reason.
    expect(
      expandRepositoryIncludes({
        content:
          'include = ["teams/*/rules.toml", "mcp/*", "../x/*.toml"]\n[policy]\nversion = 2\n',
        files: files({}),
      }).errors,
    ).toEqual([
      'include: "teams/*/rules.toml" is not a valid glob: only the file name may hold `*`',
      'include: "mcp/*" is not a valid glob: the file name must end in `.toml`',
      'include: "../x/*.toml" is not a valid glob: the folder must be a folder beside the policy file, outside batteries/, with no `.` or `..` segment',
    ]);
    expect(
      expandRepositoryIncludes({
        content:
          'include = ["teams/*.toml", "teams/pay*.toml"]\n[policy]\nversion = 2\n',
        files: files({ "teams/payments.toml": rule("payments_api__x") }),
      }).errors,
    ).toEqual([
      'include: "teams/payments.toml" matches more than one glob entry; a file loads at one entry only',
    ]);
  });

  test("a server's file holds only that server's rules and annotators, whoever reviewed it", () => {
    const own = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__refund_payment(amount:*)"
requires = { attention = ["payments-refund"] }
delta = {}

[[policy.tool]]
name = "mcp/payments_api/get_invoice"
tags = ["support"]
delta = {}

[[policy.tool]]
name = "export_ledger"
server = "payments_api"
delta = {}

[[policy.annotator]]
name = "payments_api.refund-check"
builtin = "archestra"
`;
    expect(includedFileErrors("mcp/payments_api.toml", own)).toEqual([]);
    // The same text is no other server's.
    expect(includedFileErrors("mcp/helpdesk.toml", own)).toEqual([
      expect.stringMatching(
        /^mcp\/helpdesk\.toml may hold only rules for the tools of the MCP server it is named for \(helpdesk__<tool>\).*; it sets payments_api__refund_payment\(amount:\*\), mcp\/payments_api\/get_invoice, export_ledger on server "payments_api", annotator "payments_api\.refund-check"$/,
      ),
    ]);
    const reaching = `[policy]
version = 2

[[policy.tool]]
name = "*"
delta = {}

[[policy.tool]]
name = "refund_payment"
delta = {}

[[policy.tool]]
name = "payments_api__shadow__export_all"
delta = {}

[[policy.authority]]
name = "payments_api.anyone"

[[policy.sanitizer]]
name = "payments_api.clean"
on = ["tool_output"]
`;
    expect(includedFileErrors("mcp/payments_api.toml", reaching)).toEqual([
      "mcp/payments_api.toml may hold only rules for the tools of the MCP server it is named for (payments_api__<tool>) and annotators named payments_api.<name>, and declares no authority or sanitizer; it sets *, refund_payment, payments_api__shadow__export_all, [[policy.authority]] payments_api.anyone, [[policy.sanitizer]] payments_api.clean",
    ]);
    // A file outside mcp/ is scoped by appa.toml, which names it.
    expect(includedFileErrors("teams/support.toml", reaching)).toEqual([]);
    expect(
      includedFileErrors("mcp/Payments API.toml", "[policy]\nversion = 2\n"),
    ).toEqual([
      'mcp/Payments API.toml: mcp/ holds one file per MCP server, named by its tools\' prefix; "Payments API" is not a tool prefix',
    ]);
    expect(
      includedFileErrors(
        "mcp/payments_api.toml",
        `[policy]\nversion = 2\n\n[policy.deployment]\nconfined_results = ["helpdesk__read_ticket"]\n`,
      ),
    ).toEqual([
      'mcp/payments_api.toml: confined_results may list only tools this file declares; "helpdesk__read_ticket" is not one',
    ]);
    expect(
      governsServerTool("payments_api", {
        name: "read_ticket",
        server: "helpdesk",
      }),
    ).toBe(false);
  });

  test("a server's file cannot replace an annotator a battery the root includes declares", () => {
    const github = `[policy]
version = 2

[[policy.annotator]]
name = "github.repository-visibility"
builtin = "archestra"

[[policy.annotator]]
name = "github.release-check"
builtin = "archestra"
`;
    const root = `include = ["batteries/github/appa.toml", "mcp/*.toml"]\n\n[policy]\nversion = 2\n`;
    const included = files({ "mcp/github.toml": github });
    expect(serverFilesDeclareAnnotators(included)).toBe(true);
    expect(
      serverFilesDeclareAnnotators(
        files({
          "mcp/helpdesk.toml": HELPDESK,
          "teams/payments.toml": PAYMENTS,
        }),
      ),
    ).toBe(false);
    // Folded in, the annotator would be the root's, and replace the battery's
    // for every server the battery governs.
    const batteryHelpers = new Map([
      ["github.repository-visibility", "github"],
      ["github.repository-readers", "github"],
    ]);
    expect(
      expandRepositoryIncludes({
        content: root,
        files: included,
        batteryHelpers,
      }).errors,
    ).toEqual([
      'mcp/github.toml: the github battery also declares annotator "github.repository-visibility", and a server file cannot replace a battery\'s annotator. Name it github.<another name>.',
    ]);
    // TOML spells a key many ways; the parsed name is the one checked.
    const escaped = files({
      "mcp/github.toml": `[policy]
version = 2

[[policy."annot\\u0061tor"]]
name = "github.repository-vis\\u0069bility"
builtin = "archestra"
`,
    });
    expect(serverFilesDeclareAnnotators(escaped)).toBe(true);
    expect(
      expandRepositoryIncludes({
        content: root,
        files: escaped,
        batteryHelpers,
      }).errors,
    ).toEqual([
      'mcp/github.toml: the github battery also declares annotator "github.repository-visibility", and a server file cannot replace a battery\'s annotator. Name it github.<another name>.',
    ]);
    // With no battery declaring them, both are the server's own.
    const folded = expandRepositoryIncludes({
      content: root,
      files: included,
      batteryHelpers: new Map(),
    });
    expect(folded.errors).toEqual([]);
    expect(
      (
        parse(folded.content) as {
          policy: { annotator: Array<{ name: string }> };
        }
      ).policy.annotator.map((entry) => entry.name),
    ).toEqual(["github.repository-visibility", "github.release-check"]);
  });

  test("<prefix>__* is the server's own catch-all: one rule for each of its tools the file has no plain rule for, after the file's own", () => {
    const payments = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__*"
delta = { trust = "suspicious" }

[[policy.tool]]
name = "payments_api__refund_payment"
requires = { trust = "trusted" }
delta = {}

[[policy.tool]]
name = "payments_api__get_invoice(customer:vip-*)"
delta = { audience = ["self"] }
`;
    expect(includedFileErrors("mcp/payments_api.toml", payments)).toEqual([]);
    const all = files({ "mcp/payments_api.toml": payments });
    expect(serverCatchAllPrefixes(all)).toEqual(["payments_api"]);
    expect(
      serverCatchAllPrefixes(files({ "mcp/helpdesk.toml": HELPDESK })),
    ).toEqual([]);
    // An escaped spelling of the catch-all is the catch-all too.
    expect(
      serverCatchAllPrefixes(
        files({
          "mcp/helpdesk.toml": `[policy]\nversion = 2\n\n[[policy.tool]]\nname = "helpdesk__\\u002a"\ndelta = {}\n`,
        }),
      ),
    ).toEqual(["helpdesk"]);
    const root = `include = ["mcp/*.toml"]\n[policy]\nversion = 2\n`;
    const expanded = expandRepositoryIncludes({
      content: root,
      files: all,
      serverTools: new Map([
        [
          "payments_api",
          [
            "payments_api__refund_payment",
            "payments_api__get_invoice",
            "payments_api__export_ledger",
            // Another server's tool that only starts with the prefix.
            "payments_api__shadow__export_all",
          ],
        ],
      ]),
    });
    expect(expanded.errors).toEqual([]);
    const tools = (
      parse(expanded.content) as {
        policy: { tool: Array<{ name: string; delta: unknown }> };
      }
    ).policy.tool;
    expect(tools.map((tool) => tool.name)).toEqual([
      "payments_api__refund_payment",
      "payments_api__get_invoice(customer:vip-*)",
      // A plain rule wins over the catch-all; a selector leaves the rest of
      // the tool's calls to it.
      "payments_api__export_ledger",
      "payments_api__get_invoice",
    ]);
    expect(tools[2]?.delta).toEqual({ trust: "suspicious" });
    expect(expanded.covered.get("mcp/payments_api.toml")).toEqual([
      "payments_api__export_ledger",
      "payments_api__get_invoice",
    ]);
    // With no tools known, the catch-all governs nothing.
    expect(
      (
        parse(
          expandRepositoryIncludes({ content: root, files: all }).content,
        ) as {
          policy: { tool: Array<{ name: string }> };
        }
      ).policy.tool.map((tool) => tool.name),
    ).toEqual([
      "payments_api__refund_payment",
      "payments_api__get_invoice(customer:vip-*)",
    ]);
  });
});

test("withIncludeEntry adds the entry as its own line in a multi-line list, and through OpenAPPA's editor otherwise", async () => {
  const multi = `include = [
  "batteries/archestra/appa.toml",
  "batteries/claude-code/appa.toml",
]

[policy]
version = 2
`;
  expect(await withIncludeEntry(multi, "mcp/*.toml")).toBe(`include = [
  "batteries/archestra/appa.toml",
  "batteries/claude-code/appa.toml",
  "mcp/*.toml",
]

[policy]
version = 2
`);
  // A last entry without its comma gets one; a comment after the list stays.
  const uncommaed = `include = [\n  "batteries/archestra/appa.toml"\n] # batteries\n[policy]\nversion = 2\n`;
  expect(await withIncludeEntry(uncommaed, "rules/*.toml")).toBe(
    `include = [\n  "batteries/archestra/appa.toml",\n  "rules/*.toml",\n] # batteries\n[policy]\nversion = 2\n`,
  );
  // One line, or no list: OpenAPPA's editor writes it.
  const single = `include = ["batteries/archestra/appa.toml"]\n[policy]\nversion = 2\n`;
  const edited = await withIncludeEntry(single, "mcp/*.toml");
  expect(edited).toContain('"mcp/*.toml"');
  expect(
    await withIncludeEntry("[policy]\nversion = 2\n", "mcp/*.toml"),
  ).toContain('include = ["mcp/*.toml"]');
});

test("a folder counts as included only through its whole glob: one file by name or a narrower glob leaves other servers out", () => {
  const root = (entries: string[]) =>
    `include = [${entries.map((entry) => JSON.stringify(entry)).join(", ")}]\n[policy]\nversion = 2\n`;
  expect(includesServerRulesFolder(root(["mcp/*.toml"]), "mcp")).toBe(true);
  expect(
    includesServerRulesFolder(
      root(["batteries/archestra/appa.toml", "rules/servers/*.toml"]),
      "rules/servers",
    ),
  ).toBe(true);
  // A named file, a narrower glob, another folder, or a nested one: not the folder.
  expect(includesServerRulesFolder(root(["mcp/a.toml"]), "mcp")).toBe(false);
  expect(includesServerRulesFolder(root(["mcp/a*.toml"]), "mcp")).toBe(false);
  expect(includesServerRulesFolder(root(["mcps/*.toml"]), "mcp")).toBe(false);
  expect(includesServerRulesFolder(root(["mcp/*.toml"]), "mcp/payments")).toBe(
    false,
  );
  expect(includesServerRulesFolder("[policy]\nversion = 2\n", "mcp")).toBe(
    false,
  );
});
