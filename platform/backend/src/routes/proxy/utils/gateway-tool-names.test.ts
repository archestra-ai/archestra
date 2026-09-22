import { randomUUID } from "node:crypto";
import {
  attestToolDescription,
  type ToolAttestationKind,
} from "@/archestra-mcp-server/tool-attestation";
import { describe, expect, test } from "@/test";
import type { GatewayToolDeclaration } from "./gateway-tool-declarations";
import {
  FOREIGN_TOOL_NAME_PREFIX,
  resolveGatewayToolIdentity,
} from "./gateway-tool-names";

const ORG = "org-gateway-tool-names";
const GATEWAY = randomUUID();

describe("resolveGatewayToolIdentity: attested", () => {
  // The label is whatever the person connecting the client typed; the marker
  // the gateway minted is what names the tool.
  test.each([
    "gw",
    "My-Gateway_Prod",
    "archestra",
  ])("resolves an attested tool under the label %s in every client form", async (label) => {
    const forms: GatewayToolDeclaration[] = [
      { name: `mcp__${label}__archestra__run_tool` },
      { name: `${label}_archestra__run_tool` },
      { name: "archestra__run_tool", namespace: `mcp__${label}` },
      { name: "archestra__run_tool" },
    ];
    for (const form of forms) {
      const declaration = { ...form, marker: markerOf("archestra__run_tool") };
      const identity = await resolve([declaration]);

      expect(identity.mode).toBe("attested");
      expect(identity.looseRunToolDispatch).toBe(false);
      expect(identity.canonicalize(form.name, form.namespace)).toBe(
        "archestra__run_tool",
      );
      expect(identity.attestationOf(form.name, form.namespace)).toEqual({
        ...form,
        gatewayId: GATEWAY,
        kind: "b",
        advertisedName: "archestra__run_tool",
      });
    }
  });

  test("resolves a wire name the client hashed or renamed", async () => {
    const identity = await resolve([
      { name: "mcp__gw__x9f3", marker: markerOf("archestra__run_tool") },
    ]);

    expect(identity.canonicalize("mcp__gw__x9f3")).toBe("archestra__run_tool");
  });

  // A name without a valid marker keeps its own spelling; one that would
  // read as a built-in is marked foreign, so no strict check can match it.
  test("an unattested name never reads as a built-in", async () => {
    const identity = await resolve([
      {
        name: "mcp__gw__archestra__search_tools",
        marker: markerOf("archestra__search_tools"),
      },
      { name: "mcp__evil__archestra__run_tool" },
      { name: "mcp__evil__github__list_repos" },
    ]);

    expect(identity.canonicalize("archestra__whoami")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}archestra__whoami`,
    );
    // A bare short name confers nothing on its own, so it keeps its spelling.
    expect(identity.canonicalize("run_tool")).toBe("run_tool");
    expect(identity.canonicalize("mcp__evil__archestra__run_tool")).toBe(
      "mcp__evil__archestra__run_tool",
    );
    expect(identity.canonicalize("archestra__run_tool", "mcp__evil")).toBe(
      "mcp__evil__archestra__run_tool",
    );
    // No prefix is learned from `mcp__evil__archestra__run_tool` either.
    expect(identity.canonicalize("mcp__evil__github__list_repos")).toBe(
      "mcp__evil__github__list_repos",
    );
    expect(
      identity.attestationOf("mcp__evil__archestra__run_tool"),
    ).toBeUndefined();
  });

  // Policies are looked up by name, so an unattested spelling of a name the
  // gateway serves would be ruled, and its results trusted, as the real tool.
  test.each<[string, GatewayToolDeclaration]>([
    // OpenCode: a server labeled `github` advertising `_list_repos`.
    ["OpenCode", { name: "gw_github__list_repos" }],
    ["Claude Code", { name: "mcp__gw__github__list_repos" }],
    ["Codex", { name: "github__list_repos", namespace: "mcp__gw" }],
  ])("an unattested spelling of a tool the gateway attests is foreign (%s)", async (_client, attested) => {
    const identity = await resolve([
      { ...attested, marker: markerOf("github__list_repos") },
      { name: "github__list_repos" },
    ]);

    expect(identity.canonicalize(attested.name, attested.namespace)).toBe(
      "github__list_repos",
    );
    expect(identity.canonicalize("github__list_repos")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}github__list_repos`,
    );
    // Its own spelling under another label stays its own.
    expect(identity.canonicalize("mcp__evil__github__list_repos")).toBe(
      "mcp__evil__github__list_repos",
    );
  });

  // A gateway that lists only its dispatch pair attests no third-party name,
  // but an installed MCP server's tool is still a real tool.
  test("an unattested spelling of an installed MCP server's tool is foreign", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    await makeTool({ name: "ghx__list_repos", catalogId: catalog.id });
    const proxy = await makeAgent({ agentType: "llm_proxy" });
    // A name only the proxy discovered: no gateway serves it.
    await makeTool({ name: "local__notes", agentId: proxy.id });

    const identity = await resolve([
      { name: "archestra__run_tool", marker: markerOf("archestra__run_tool") },
      { name: "ghx__list_repos" },
      { name: "local__notes" },
    ]);

    expect(identity.canonicalize("ghx__list_repos")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}ghx__list_repos`,
    );
    expect(identity.canonicalize("local__notes")).toBe("local__notes");

    const chat = await resolve(
      [
        {
          name: "archestra__run_tool",
          marker: markerOf("archestra__run_tool"),
        },
        { name: "ghx__list_repos" },
      ],
      { internalChat: true },
    );
    expect(chat.canonicalize("ghx__list_repos")).toBe("ghx__list_repos");
  });

  test("Chat's own unattested names keep their identity", async () => {
    const identity = await resolve(
      [
        {
          name: "archestra__search_tools",
          marker: markerOf("archestra__search_tools"),
        },
        { name: "archestra__whoami" },
      ],
      { internalChat: true },
    );

    expect(identity.mode).toBe("attested");
    expect(identity.canonicalize("archestra__whoami")).toBe(
      "archestra__whoami",
    );
  });

  test("a marker with a wrong MAC is unattested and counted", async () => {
    const forged = transplantMac({
      from: markerOf("archestra__whoami"),
      onto: markerOf("archestra__run_tool"),
    });
    const identity = await resolve([
      {
        name: "mcp__gw__archestra__search_tools",
        marker: markerOf("archestra__search_tools"),
      },
      { name: "mcp__evil__archestra__run_tool", marker: forged },
      { name: "archestra__run_tool", marker: forged },
    ]);

    expect(identity.unverifiedMarkerCount).toBe(2);
    expect(identity.verified).toHaveLength(1);
    expect(identity.canonicalize("mcp__evil__archestra__run_tool")).toBe(
      "mcp__evil__archestra__run_tool",
    );
    expect(identity.canonicalize("archestra__run_tool")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}archestra__run_tool`,
    );
  });

  test("a marker minted for another organization does not verify", async () => {
    const identity = await resolve(
      [
        {
          name: "mcp__gw__archestra__search_tools",
          marker: markerOf("archestra__search_tools", {
            organizationId: "org-b",
          }),
        },
        {
          name: "archestra__run_tool",
          marker: markerOf("archestra__run_tool"),
        },
      ],
      { organizationId: "org-b" },
    );

    expect(identity.unverifiedMarkerCount).toBe(1);
    expect(identity.canonicalize("mcp__gw__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );
    expect(identity.canonicalize("archestra__run_tool")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}archestra__run_tool`,
    );
  });

  // The gateway advertises a name once. Under two spellings, one of them is
  // a replayed marker or a second registration, and nothing says which.
  test("the same gateway tool under two spellings loses its attestation on both", async () => {
    const marker = markerOf("archestra__run_tool");
    const identity = await resolve([
      { name: "mcp__gw__archestra__run_tool", marker },
      { name: "mcp__evil__archestra__run_tool", marker },
      { name: "archestra__run_tool", marker },
    ]);

    expect(identity.mode).toBe("attested");
    expect(identity.verified).toHaveLength(3);
    for (const name of [
      "mcp__gw__archestra__run_tool",
      "mcp__evil__archestra__run_tool",
      "archestra__run_tool",
    ]) {
      expect(identity.attestationOf(name)).toBeUndefined();
    }
    expect(identity.canonicalize("mcp__gw__archestra__run_tool")).toBe(
      "mcp__gw__archestra__run_tool",
    );
    expect(identity.canonicalize("archestra__run_tool")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}archestra__run_tool`,
    );
  });

  test("the same third-party tool from two gateways stays attested on both", async () => {
    const other = randomUUID();
    const identity = await resolve([
      { name: "mcp__a__github__x", marker: markerOf("github__x") },
      {
        name: "mcp__b__github__x",
        marker: markerOf("github__x", { gatewayId: other }),
      },
    ]);

    expect(identity.canonicalize("mcp__a__github__x")).toBe("github__x");
    expect(identity.canonicalize("mcp__b__github__x")).toBe("github__x");
    expect(identity.attestationOf("mcp__b__github__x")?.gatewayId).toBe(other);
    // Two declarations are that tool, so neither is its one spelling.
    expect(identity.spellingOf("github__x")).toBeUndefined();
  });

  test("a third-party tool the gateway advertised under a built-in name is demoted", async () => {
    const identity = await resolve([
      {
        name: "mcp__gw__archestra__whoami",
        marker: markerOf("archestra__whoami", { kind: "t" }),
      },
      {
        name: "archestra__search_tools",
        marker: markerOf("archestra__search_tools", { kind: "t" }),
      },
    ]);

    expect(
      identity.attestationOf("mcp__gw__archestra__whoami"),
    ).toBeUndefined();
    expect(identity.canonicalize("mcp__gw__archestra__whoami")).toBe(
      "mcp__gw__archestra__whoami",
    );
    expect(identity.canonicalize("archestra__search_tools")).toBe(
      `${FOREIGN_TOOL_NAME_PREFIX}archestra__search_tools`,
    );
  });

  // Control and notice status must come from a single gateway: the one that
  // serves the OpenAPPA remedy pair.
  test("built-ins from a gateway that does not own the remedy pair are demoted", async () => {
    const other = randomUUID();
    const identity = await resolve([
      {
        name: "mcp__a__archestra__execute_remedy_plan",
        marker: markerOf("archestra__execute_remedy_plan"),
      },
      {
        name: "mcp__a__archestra__get_remedy_plans",
        marker: markerOf("archestra__get_remedy_plans"),
      },
      {
        name: "mcp__a__archestra__search_tools",
        marker: markerOf("archestra__search_tools"),
      },
      {
        name: "mcp__b__archestra__search_tools",
        marker: markerOf("archestra__search_tools", { gatewayId: other }),
      },
      {
        name: "mcp__b__github__x",
        marker: markerOf("github__x", { gatewayId: other }),
      },
    ]);

    expect(identity.canonicalize("mcp__a__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );
    expect(
      identity.attestationOf("mcp__b__archestra__search_tools"),
    ).toBeUndefined();
    expect(identity.canonicalize("mcp__b__archestra__search_tools")).toBe(
      "mcp__b__archestra__search_tools",
    );
    // Only built-ins are at stake; the other gateway's own tools stay.
    expect(identity.canonicalize("mcp__b__github__x")).toBe("github__x");
  });

  test("without a single remedy-pair owner, built-ins from every gateway stay", async () => {
    const other = randomUUID();
    const withoutOwner = await resolve([
      {
        name: "mcp__a__archestra__search_tools",
        marker: markerOf("archestra__search_tools"),
      },
      {
        name: "mcp__b__archestra__search_tools",
        marker: markerOf("archestra__search_tools", { gatewayId: other }),
      },
    ]);
    expect(withoutOwner.canonicalize("mcp__a__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );
    expect(withoutOwner.canonicalize("mcp__b__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );

    const bothOwners = await resolve(
      [GATEWAY, other].flatMap((gatewayId, index) =>
        ["archestra__execute_remedy_plan", "archestra__get_remedy_plans"].map(
          (advertisedName) => ({
            name: `mcp__g${index}__${advertisedName}`,
            marker: markerOf(advertisedName, { gatewayId }),
          }),
        ),
      ),
    );
    expect(
      bothOwners.canonicalize("mcp__g1__archestra__get_remedy_plans"),
    ).toBe("archestra__get_remedy_plans");
  });

  test("spellingOf returns the declared spelling, with its namespace", async () => {
    const claude = await resolve([
      {
        name: "mcp__gw__archestra__run_tool",
        marker: markerOf("archestra__run_tool"),
      },
    ]);
    expect(claude.spellingOf("archestra__run_tool")).toEqual({
      name: "mcp__gw__archestra__run_tool",
    });

    const codex = await resolve([
      {
        name: "archestra__run_tool",
        namespace: "mcp__gw",
        marker: markerOf("archestra__run_tool"),
      },
    ]);
    expect(codex.spellingOf("archestra__run_tool")).toEqual({
      name: "archestra__run_tool",
      namespace: "mcp__gw",
    });
    expect(codex.spellingOf("archestra__search_tools")).toBeUndefined();
  });
});

describe("resolveGatewayToolIdentity: compat", () => {
  test("is compat, with the loose run_tool scan, when no marker verifies", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const forged = transplantMac({
      from: markerOf("archestra__whoami", { organizationId: org.id }),
      onto: markerOf("archestra__run_tool", { organizationId: org.id }),
    });

    const identity = await resolveGatewayToolIdentity({
      organizationId: org.id,
      declarations: [{ name: "archestra__run_tool", marker: forged }],
      internalChat: false,
    });

    expect(identity.mode).toBe("compat");
    expect(identity.looseRunToolDispatch).toBe(true);
    expect(identity.unverifiedMarkerCount).toBe(1);
    expect(identity.verified).toEqual([]);
    expect(identity.attestationOf("archestra__run_tool")).toBeUndefined();
  });

  test("strips a Claude Code style decoration for the org's own gateway", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("mcp__prod_gateway__archestra__run_tool")).toBe(
      "archestra__run_tool",
    );
    expect(canonicalize("mcp__prod_gateway__github__create_issue")).toBe(
      "github__create_issue",
    );
  });

  test("strips a decoration whose gateway label sits first", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("prod_gateway__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );
  });

  // A label in first position must leave a `<server>__<tool>` name behind and
  // is never expanded: an ordinary tool whose server shares a gateway's name
  // is not a built-in.
  test("a label in first position never yields an expanded short name", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Filesystem",
    });
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("filesystem__read_file")).toBe("filesystem__read_file");
    expect(canonicalize("prod_gateway__run_tool")).toBe(
      "prod_gateway__run_tool",
    );
    expect(canonicalize("prod_gateway__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );
  });

  // OpenCode presents an MCP tool as `<label>_<advertised name>`: the label is
  // joined with one underscore, not the `__` segment separator.
  test("strips an OpenCode style decoration for the org's own gateway", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("prod_gateway_archestra__whoami")).toBe(
      "archestra__whoami",
    );
    expect(canonicalize("prod_gateway_github__create_issue")).toBe(
      "github__create_issue",
    );
    // A name the label merely prefixes is not a gateway tool.
    expect(canonicalize("prod_gateway_notes")).toBe("prod_gateway_notes");
  });

  test("expands a bare built-in short name left after stripping behind a client prefix", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("mcp__prod_gateway__run_tool")).toBe(
      "archestra__run_tool",
    );
  });

  // Codex puts the label in a namespace and calls the member by its bare
  // name. Any server's namespace can hold a member spelled like ours, so a
  // namespaced name is resolved whole, never by its member name.
  test("resolves a Codex namespace member together with its namespace", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const identity = await resolveGatewayToolIdentity({
      organizationId: org.id,
      declarations: [
        { name: "archestra__run_tool", namespace: "mcp__prod_gateway" },
        { name: "archestra__run_tool", namespace: "mcp__evil" },
      ],
      internalChat: false,
    });

    expect(
      identity.canonicalize("archestra__run_tool", "mcp__prod_gateway"),
    ).toBe("archestra__run_tool");
    expect(identity.canonicalize("archestra__run_tool", "mcp__evil")).toBe(
      "mcp__evil__archestra__run_tool",
    );
    expect(identity.spellingOf("archestra__run_tool")).toEqual({
      name: "archestra__run_tool",
      namespace: "mcp__prod_gateway",
    });
  });

  test("leaves foreign server labels and undecorated names untouched", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    // A hostile or unrelated MCP server connected directly to the client must
    // not get its tools canonicalized into platform names.
    expect(canonicalize("mcp__evil__archestra__run_tool")).toBe(
      "mcp__evil__archestra__run_tool",
    );
    expect(canonicalize("github__create_issue")).toBe("github__create_issue");
    expect(canonicalize("plain_tool")).toBe("plain_tool");
  });

  test("is the identity when the organization has no gateways", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("mcp__prod_gateway__archestra__run_tool")).toBe(
      "mcp__prod_gateway__archestra__run_tool",
    );
  });

  test("does not treat another organization's gateway name as a label", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const otherOrg = await makeOrganization();
    await makeAgent({
      organizationId: otherOrg.id,
      agentType: "mcp_gateway",
      name: "Other Gateway",
    });
    const org = await makeOrganization();

    const canonicalize = await compatCanonicalizer({ organizationId: org.id });

    expect(canonicalize("mcp__other_gateway__archestra__run_tool")).toBe(
      "mcp__other_gateway__archestra__run_tool",
    );
  });

  // A label that matches no gateway name is learned from the request's own
  // tool list: whichever prefix sits in front of one of our branded names.
  test("learns the client's label from the request when it matches no gateway name", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await compatCanonicalizer({
      organizationId: org.id,
      declaredToolNames: [
        "mcp__some_local_alias__archestra__run_tool",
        "mcp__some_local_alias__github__list_repos",
        "Bash",
      ],
    });

    expect(canonicalize("mcp__some_local_alias__github__list_repos")).toBe(
      "github__list_repos",
    );
  });

  // Built-ins bypass tool-invocation and trusted-data policies, so a prefix
  // any server can claim must never confer that status.
  test("a learned prefix never yields a branded built-in name", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await compatCanonicalizer({
      organizationId: org.id,
      declaredToolNames: ["mcp__impostor__archestra__run_tool"],
    });

    expect(canonicalize("mcp__impostor__archestra__run_tool")).toBe(
      "mcp__impostor__archestra__run_tool",
    );
  });

  test("learns an OpenCode label from the request, never yielding a built-in", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await compatCanonicalizer({
      organizationId: org.id,
      declaredToolNames: [
        "local_alias_archestra__run_tool",
        "local_alias_github__list_repos",
        "bash",
      ],
    });

    expect(canonicalize("local_alias_github__list_repos")).toBe(
      "github__list_repos",
    );
    expect(canonicalize("local_alias_archestra__run_tool")).toBe(
      "local_alias_archestra__run_tool",
    );
  });

  // Nothing to learn from means nothing changes.
  test("leaves names alone when the request declares no branded tool", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await compatCanonicalizer({
      organizationId: org.id,
      declaredToolNames: ["mcp__unknown__github__list_repos", "Bash"],
    });

    expect(canonicalize("mcp__unknown__github__list_repos")).toBe(
      "mcp__unknown__github__list_repos",
    );
  });
});

describe("resolveGatewayToolIdentity: chat", () => {
  test("takes Chat's names as they are when none carries a marker", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const identity = await resolveGatewayToolIdentity({
      organizationId: org.id,
      declarations: [{ name: "archestra__run_tool" }],
      internalChat: true,
    });

    expect(identity.mode).toBe("chat");
    expect(identity.looseRunToolDispatch).toBe(false);
    expect(identity.canonicalize("archestra__run_tool")).toBe(
      "archestra__run_tool",
    );
    expect(
      identity.canonicalize("mcp__prod_gateway__archestra__run_tool"),
    ).toBe("mcp__prod_gateway__archestra__run_tool");
    expect(identity.canonicalize("archestra__run_tool", "mcp__gw")).toBe(
      "mcp__gw__archestra__run_tool",
    );
    expect(identity.spellingOf("archestra__run_tool")).toEqual({
      name: "archestra__run_tool",
    });
  });
});

// === Helpers ===

async function resolve(
  declarations: GatewayToolDeclaration[],
  options: { internalChat?: boolean; organizationId?: string } = {},
) {
  return await resolveGatewayToolIdentity({
    organizationId: options.organizationId ?? ORG,
    declarations,
    internalChat: options.internalChat ?? false,
  });
}

async function compatCanonicalizer(params: {
  organizationId: string;
  declaredToolNames?: string[];
}) {
  const identity = await resolveGatewayToolIdentity({
    organizationId: params.organizationId,
    declarations: (params.declaredToolNames ?? []).map((name) => ({ name })),
    internalChat: false,
  });
  expect(identity.mode).toBe("compat");
  return identity.canonicalize;
}

/** The marker the gateway mints for a tool it serves under `advertisedName`. */
function markerOf(
  advertisedName: string,
  options: {
    kind?: ToolAttestationKind;
    gatewayId?: string;
    organizationId?: string;
  } = {},
): string {
  const marker = attestToolDescription({
    organizationId: options.organizationId ?? ORG,
    gatewayId: options.gatewayId ?? GATEWAY,
    advertisedName,
    kind:
      options.kind ?? (advertisedName.startsWith("archestra__") ? "b" : "t"),
    description: undefined,
  });
  if (!marker) throw new Error("attestation is off in this test environment");
  return marker;
}

/** A well-formed marker whose MAC belongs to another payload. */
function transplantMac(params: { from: string; onto: string }): string {
  const mac = params.from.slice(params.from.lastIndexOf(".") + 1, -2);
  const payload = params.onto.slice(0, params.onto.lastIndexOf(".") + 1);
  return `${payload}${mac}]]`;
}
