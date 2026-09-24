import { createHash } from "node:crypto";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { guardrailsPolicyService } from "@/services/guardrails-policy";

/**
 * The organization the OpenAPPA coverage tests read:
 *
 * - `Docs` (prefix `docs`) is governed by the bundled `microsoft-learn`
 *   battery, carries a root selector rule beside it and one unlisted tool that
 *   looks like a read: guarded.
 * - `Acme` (prefix `acme`) is governed by the uploaded `acme` battery and two
 *   root rules, every tool named, one rule requiring something: strict.
 * - `Linear` has no synced tool, and its URL is one the bundled `linear`
 *   battery stands for: open, and fitted.
 * - With `github`, the bundled `github` battery (which lacks its credential)
 *   is aimed at `Gh` alone (declared, not enforced) and, beside `acme`, at
 *   `Mixed` (partly enforced).
 * - With `refused`, the uploaded battery binds a helper to an annotator it
 *   never declares, so the runtime refuses the composition.
 *
 * `Alpha` is assigned a tool of Docs and one of Acme, `Beta` one of Acme, and
 * with `github`, `Gamma` one of Gh.
 */
export async function seedCoverage(params: {
  organizationId: string;
  userId: string;
  fixtures: CoverageFixtures;
  github?: boolean;
  refused?: boolean;
}) {
  const { organizationId, userId, fixtures } = params;
  const catalog = (name: string, serverUrl?: string, icon?: string) =>
    fixtures.makeInternalMcpCatalog({ organizationId, name, serverUrl, icon });
  const tools = async (catalogId: string, names: string[]) => {
    const made: Record<string, string> = {};
    for (const name of names)
      made[name] = (
        await fixtures.makeTool({
          catalogId,
          name,
          rawName: name.slice(name.indexOf("__") + 2),
        })
      ).id;
    return made;
  };

  const docs = await catalog(
    "Docs",
    "https://learn.microsoft.com/api/mcp",
    "📚",
  );
  const acme = await catalog("Acme");
  const linear = await catalog("Linear", "https://mcp.linear.app/mcp");
  const toolIds = {
    ...(await tools(docs.id, [
      "docs__microsoft_docs_search",
      "docs__microsoft_docs_fetch",
      "docs__list_pages",
    ])),
    ...(await tools(acme.id, [
      "acme__list_items",
      "acme__create_item",
      "acme__delete_item",
      "acme__ping",
    ])),
  };
  const catalogIds: Record<string, string> = {
    docs: docs.id,
    acme: acme.id,
    linear: linear.id,
  };
  if (params.github) {
    const gh = await catalog("Gh");
    const mixed = await catalog("Mixed");
    catalogIds.gh = gh.id;
    catalogIds.mixed = mixed.id;
    Object.assign(
      toolIds,
      await tools(gh.id, ["gh__get_me"]),
      await tools(mixed.id, ["mixed__list_items", "mixed__get_me"]),
    );
  }

  const { entry } = await openappaBatteriesService.uploadPackage({
    userId,
    organizationId,
    name: "acme",
    files: acmePackage(params.refused ?? false),
  });
  const content = rootPolicy({ acmeEntry: entry, github: params.github });
  const latest = await guardrailsPolicyService.get(organizationId);
  if (params.refused) {
    // The refusal is the composition's, so the text is saved without the
    // check a save through the service would make.
    await GuardrailsPolicyModel.save({
      organizationId,
      updatedBy: userId,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      expectedRevision: latest.revision,
    });
  } else {
    await guardrailsPolicyService.update({
      organizationId,
      userId,
      content,
      expectedRevision: latest.revision,
    });
  }
  await openappaBatteriesService.recompile(organizationId);

  const agent = async (name: string, assigned: string[]) => {
    const made = await fixtures.makeAgent({ organizationId, name });
    for (const tool of assigned)
      await fixtures.makeAgentTool(made.id, toolIds[tool]);
    return made.id;
  };
  const agentIds: Record<string, string> = {
    alpha: await agent("Alpha", ["docs__list_pages", "acme__list_items"]),
    beta: await agent("Beta", ["acme__ping"]),
  };
  if (params.github) agentIds.gamma = await agent("Gamma", ["gh__get_me"]);

  return { content, catalogIds, toolIds, agentIds };
}

/** The 1-based line of the `[[policy.tool]]` header above a rule's name line. */
export function ruleLine(content: string, name: string): number {
  return content.split("\n").indexOf(`name = "${name}"`);
}

// =============================================================================
// Internal helpers
// =============================================================================

type CoverageFixtures = {
  makeInternalMcpCatalog: (overrides: {
    organizationId: string;
    name: string;
    serverUrl?: string;
    icon?: string;
  }) => Promise<{ id: string }>;
  makeTool: (overrides: {
    catalogId: string;
    name: string;
    rawName: string;
  }) => Promise<{ id: string }>;
  makeAgent: (overrides: {
    organizationId: string;
    name: string;
  }) => Promise<{ id: string }>;
  makeAgentTool: (agentId: string, toolId: string) => Promise<unknown>;
};

function rootPolicy(params: { acmeEntry: string; github?: boolean }): string {
  const includes = [
    "batteries/microsoft-learn/appa.toml",
    params.acmeEntry,
    ...(params.github ? ["batteries/github/appa.toml"] : []),
  ];
  return `include = [${includes.map((entry) => `"${entry}"`).join(", ")}]

[server_aliases]
microsoft-learn = ["docs"]
acme = [${params.github ? `"acme", "mixed"` : `"acme"`}]
jira = ["jira_cloud"]
${params.github ? `github = ["gh", "mixed"]\n` : ""}
[policy]
version = 2

[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "docs__microsoft_docs_search(query:*azure*)"
delta = { trust = "suspicious", audience = ["public"] }

[[policy.tool]]
name = "acme__delete_item"
delta = {}
requires = { trust = "trusted" }

[[policy.tool]]
name = "acme__ping"
delta = {}

[[policy.tool]]
name = "*"
annotator = "noop"

[[policy.authority]]
name = "human"
permits = { attention = ["*"] }

[externals.annotators.noop]
url = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"

[externals.authorities.human]
builtin = "hitl"
`;
}

function acmePackage(refused: boolean) {
  return [
    {
      path: "appa-package.toml",
      text: `schema = 1
name = "acme"
description = "Acme battery under test"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
namespaces = ["acme"]
${refused ? 'helpers = ["check.py"]\n' : ""}`,
    },
    {
      path: "appa.toml",
      text: `[policy]
version = 2

[[policy.tool]]
name = "mcp/acme/list_items"
delta = { trust = "suspicious", audience = ["internal"] }

[[policy.tool]]
name = "mcp/acme/create_item"
delta = {}
requires = { trust = "trusted", attention = ["acme-review"] }
${
  refused
    ? `
[externals.annotators."acme.check"]
command = ["python3", "check.py"]
`
    : ""
}`,
    },
    ...(refused ? [{ path: "check.py", text: "print('{}')\n" }] : []),
  ];
}
