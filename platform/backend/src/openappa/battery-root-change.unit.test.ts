import { describe, expect, test } from "vitest";
import { batteryRootChange } from "./battery-root-change";

/** The bundled batteries the cases know: two that govern servers, one the organization. */
const NAMESPACES: Record<string, string[]> = {
  "microsoft-learn": ["microsoft-learn"],
  cloudflare: ["cloudflare"],
  jev: [],
};

const namespacesOf = async (name: string) => NAMESPACES[name] ?? null;

/** An uploaded package that declares cloudflare's namespace too. */
const UPLOADED_CLOUDFLARE = `batteries/cloudflare-extras@sha256-${"b".repeat(64)}/appa.toml`;

/** What the other include entries declare: a repository file declares nothing. */
const INCLUDED: Record<string, string[]> = {
  "mcp/*.toml": [],
  [UPLOADED_CLOUDFLARE]: ["cloudflare"],
};

const includedNamespacesOf = async (entry: string) => INCLUDED[entry] ?? null;

const ROOT = `include = [
  "batteries/archestra/appa.toml",
  "batteries/cloudflare/appa.toml",
  "mcp/*.toml",
]

[policy]
version = 2

[aliases.mcp]
archestra = ["archestra"]
cloudflare = ["cloudflare_docs"]

[aliases.host]
claude-code = ["archestra"]

[[policy.tool]]
name = "github__create_issue"
delta = {}
`;

const change = (after: string, before = ROOT) =>
  batteryRootChange({ before, after, namespacesOf, includedNamespacesOf });

const prefixes = async (after: string, before = ROOT) => {
  const result = await change(after, before);
  if ("refused" in result) throw new Error(result.refused);
  return [...result.prefixes].sort();
};

describe("batteryRootChange", () => {
  test("attaching a new battery to a server touches that server's prefix", async () => {
    const after = ROOT.replace(
      '"mcp/*.toml",',
      '"mcp/*.toml", "batteries/microsoft-learn/appa.toml",',
    ).replace(
      'cloudflare = ["cloudflare_docs"]',
      'cloudflare = ["cloudflare_docs"]\nmicrosoft-learn = ["microsoft_learn"]',
    );
    expect(await prefixes(after)).toEqual(["microsoft_learn"]);
  });

  test("attaching an included battery to a second server touches only that server", async () => {
    const after = ROOT.replace(
      'cloudflare = ["cloudflare_docs"]',
      'cloudflare = ["cloudflare_docs", "cloudflare_observability"]',
    );
    expect(await prefixes(after)).toEqual(["cloudflare_observability"]);
  });

  test("detaching the last server removes the include and touches the servers it governed", async () => {
    const after = ROOT.replace(
      '  "batteries/cloudflare/appa.toml",\n',
      "",
    ).replace('cloudflare = ["cloudflare_docs"]\n', "");
    expect(await prefixes(after)).toEqual(["cloudflare_docs"]);
  });

  test("removing an include whose bindings stay touches every server they bind", async () => {
    const before = ROOT.replace(
      'cloudflare = ["cloudflare_docs"]',
      'cloudflare = ["cloudflare_docs", "cloudflare_observability"]',
    );
    const after = before.replace('  "batteries/cloudflare/appa.toml",\n', "");
    expect(await prefixes(after, before)).toEqual([
      "cloudflare_docs",
      "cloudflare_observability",
    ]);
  });

  test("formatting and comments alone do not count as a change to the rest", async () => {
    const after = `# Reviewed.\n${ROOT.replace(
      'cloudflare = ["cloudflare_docs"]',
      'cloudflare = [ "cloudflare_docs", "cloudflare_observability" ]',
    )}`;
    expect(await prefixes(after)).toEqual(["cloudflare_observability"]);
  });

  test("a rule changed beside the battery is refused", async () => {
    const result = await change(
      ROOT.replace(
        'cloudflare = ["cloudflare_docs"]',
        'cloudflare = ["cloudflare_docs", "cloudflare_observability"]',
      ).replace("delta = {}", 'delta = { audience = ["public"] }'),
    );
    expect(result).toEqual({
      refused:
        "it changes more of the policy file than which batteries govern which MCP servers",
    });
  });

  test("another alias table changed is refused", async () => {
    const result = await change(
      ROOT.replace('claude-code = ["archestra"]', 'claude-code = ["github"]'),
    );
    expect("refused" in result).toBe(true);
  });

  test("an include other than a bundled battery's is refused", async () => {
    const result = await change(
      ROOT.replace('"mcp/*.toml",', '"mcp/*.toml", "teams/support.toml",'),
    );
    expect(result).toEqual({
      refused:
        'it changes the include "teams/support.toml", which is not a bundled battery\'s',
    });
  });

  test("an uploaded battery's include is refused", async () => {
    const result = await change(
      ROOT.replace(
        '"mcp/*.toml",',
        `"mcp/*.toml", "batteries/microsoft-learn@sha256-${"a".repeat(64)}/appa.toml",`,
      ),
    );
    expect("refused" in result).toBe(true);
  });

  test("a battery that governs the organization is refused", async () => {
    const result = await change(
      ROOT.replace('"mcp/*.toml",', '"mcp/*.toml", "batteries/jev/appa.toml",'),
    );
    expect(result).toEqual({
      refused:
        "jev governs every tool call in the organization, not one MCP server's",
    });
  });

  test("a battery no bundled package has is refused", async () => {
    const result = await change(
      ROOT.replace(
        '"mcp/*.toml",',
        '"mcp/*.toml", "batteries/unknown/appa.toml",',
      ),
    );
    expect(result).toEqual({ refused: "no bundled battery is named unknown" });
  });

  test("a binding for a namespace no included battery declares is refused", async () => {
    const result = await change(
      ROOT.replace(
        'cloudflare = ["cloudflare_docs"]',
        'cloudflare = ["cloudflare_docs"]\ngithub = ["payments_api"]',
      ),
    );
    expect(result).toEqual({
      refused:
        'it binds the namespace "github", which no bundled battery the policy includes declares',
    });
  });

  test("a binding another included battery declares too is refused: it is that battery's server list as well", async () => {
    const shared = ROOT.replace(
      '"mcp/*.toml",',
      `"mcp/*.toml",\n  "${UPLOADED_CLOUDFLARE}",`,
    );
    const result = await change(
      shared.replace(
        'cloudflare = ["cloudflare_docs"]',
        'cloudflare = ["cloudflare_docs", "cloudflare_observability"]',
      ),
      shared,
    );
    expect(result).toEqual({
      refused: expect.stringContaining(
        "another battery the policy includes declares too",
      ),
    });
  });

  test("a binding moved while an included package cannot be read is refused", async () => {
    const unknown = ROOT.replace(
      '"mcp/*.toml",',
      `"mcp/*.toml",\n  "batteries/unknown@sha256-${"c".repeat(64)}/appa.toml",`,
    );
    const result = await change(
      unknown.replace(
        'cloudflare = ["cloudflare_docs"]',
        'cloudflare = ["cloudflare_docs", "cloudflare_observability"]',
      ),
      unknown,
    );
    expect(result).toEqual({
      refused: expect.stringContaining("could not be read"),
    });
  });

  test("no change to any binding is refused", async () => {
    expect(await change(`# Only a comment.\n${ROOT}`)).toEqual({
      refused:
        "it changes more of the policy file than which batteries govern which MCP servers",
    });
  });

  test("reordering or repeating the entries both files keep is refused beside a real battery change", async () => {
    const attach = (root: string) =>
      root.replace(
        'cloudflare = ["cloudflare_docs"]',
        'cloudflare = ["cloudflare_docs"]\nmicrosoft-learn = ["microsoft_learn"]',
      );
    const reordered = attach(
      ROOT.replace(
        '"batteries/archestra/appa.toml",\n  "batteries/cloudflare/appa.toml",\n  "mcp/*.toml",',
        '"mcp/*.toml",\n  "batteries/archestra/appa.toml",\n  "batteries/cloudflare/appa.toml", "batteries/microsoft-learn/appa.toml",',
      ),
    );
    const repeated = attach(
      ROOT.replace(
        '"mcp/*.toml",',
        '"mcp/*.toml", "mcp/*.toml", "batteries/microsoft-learn/appa.toml",',
      ),
    );
    for (const after of [reordered, repeated])
      expect(await change(after)).toEqual({
        refused:
          "it changes more of the policy file than which batteries govern which MCP servers",
      });
  });

  test("an include added with no server for it says so", async () => {
    const after = ROOT.replace(
      '"mcp/*.toml",',
      '"mcp/*.toml", "batteries/microsoft-learn/appa.toml",',
    );
    expect(await change(after)).toEqual({
      refused:
        "it includes or removes a battery without attaching it to an MCP server or detaching it from one",
    });
  });

  test("a file that does not parse is refused", async () => {
    expect(await change("include = [")).toEqual({
      refused: "the policy file does not parse",
    });
  });
});
