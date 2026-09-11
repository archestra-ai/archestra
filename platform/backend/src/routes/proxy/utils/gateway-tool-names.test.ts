import { describe, expect, test } from "@/test";
import { buildGatewayToolNameCanonicalizer } from "./gateway-tool-names";

describe("buildGatewayToolNameCanonicalizer", () => {
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

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
    });

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

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
    });

    expect(canonicalize("prod_gateway__archestra__search_tools")).toBe(
      "archestra__search_tools",
    );
  });

  test("expands a bare built-in short name left after stripping", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
    });

    expect(canonicalize("mcp__prod_gateway__run_tool")).toBe(
      "archestra__run_tool",
    );
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

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
    });

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

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
    });

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

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
    });

    expect(canonicalize("mcp__other_gateway__archestra__run_tool")).toBe(
      "mcp__other_gateway__archestra__run_tool",
    );
  });

  // The label is free text typed at `claude mcp add <label> <url>` time, so it
  // routinely matches no gateway this organization knows. That used to leave
  // every decorated name untouched, and guardrails then reasoned about the
  // decoration instead of the tool. The request's own tool list identifies the
  // prefix: whichever one sits in front of one of our branded names is this
  // client's decoration for our gateway.
  test("learns the client's label from the request when it matches no gateway name", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await buildGatewayToolNameCanonicalizer({
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

  // The learned prefix must not confer built-in status: built-ins bypass
  // tool-invocation and trusted-data policies, so a server that named its tools
  // after ours could otherwise opt itself out of enforcement entirely. Stripping
  // to a third-party name only ever ADDS enforcement; stripping to a branded
  // name would remove it, so that one is refused.
  test("a learned prefix never yields a branded built-in name", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
      declaredToolNames: ["mcp__impostor__archestra__run_tool"],
    });

    expect(canonicalize("mcp__impostor__archestra__run_tool")).toBe(
      "mcp__impostor__archestra__run_tool",
    );
  });

  // Nothing to learn from means nothing changes.
  test("leaves names alone when the request declares no branded tool", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
      declaredToolNames: ["mcp__unknown__github__list_repos", "Bash"],
    });

    expect(canonicalize("mcp__unknown__github__list_repos")).toBe(
      "mcp__unknown__github__list_repos",
    );
  });

  test("binds a known gateway wrapper to its registry-assigned target only", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "APPA Gateway",
    });
    const otherGateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "Other Gateway",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "APPA native live fixture",
    });
    const publicTool = await makeTool({
      catalogId: catalog.id,
      name: "appa_native_live_fixture__read_source",
    });
    const privateTool = await makeTool({
      catalogId: catalog.id,
      name: "appa_native_live_fixture__protected_publish",
    });
    await makeAgentTool(gateway.id, publicTool.id);
    await makeAgentTool(otherGateway.id, privateTool.id);

    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
      declaredToolNames: ["mcp__appa_gateway__archestra__run_tool"],
    });

    expect(canonicalize("mcp__appa_gateway__archestra__run_tool")).toBe(
      "archestra__run_tool",
    );
    expect(
      canonicalize.resolveTrustedGatewayToolTarget?.({
        emittedName: "mcp__appa_gateway__archestra__run_tool",
        targetName: "appa_native_live_fixture__read_source",
      }),
    ).toBe("mcp/appa_gateway/appa_native_live_fixture__read_source");
    // A nested name neither declares authority nor crosses into another gateway.
    expect(
      canonicalize.resolveTrustedGatewayToolTarget?.({
        emittedName: "mcp__appa_gateway__archestra__run_tool",
        targetName: "appa_native_live_fixture__protected_publish",
      }),
    ).toBeUndefined();
    expect(
      canonicalize.resolveTrustedGatewayToolTarget?.({
        emittedName: "mcp__unknown_alias__archestra__run_tool",
        targetName: "appa_native_live_fixture__read_source",
      }),
    ).toBeUndefined();
  });

  test("qualifies the trusted search_tools wrapper for the APPA contract", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "APPA Gateway",
    });
    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
      declaredToolNames: ["mcp__appa_gateway__archestra__search_tools"],
    });

    expect(
      canonicalize.resolveTrustedGatewayToolTarget?.({
        emittedName: "mcp__appa_gateway__archestra__search_tools",
        targetName: "archestra__search_tools",
      }),
    ).toBe("mcp/appa_gateway/archestra__search_tools");
  });

  test("binds OpenCode's declared native gateway wrapper to its assigned target", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "APPA Gateway",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "APPA native live fixture",
    });
    const publicTool = await makeTool({
      catalogId: catalog.id,
      name: "appa_native_live_fixture__read_source",
    });
    await makeAgentTool(gateway.id, publicTool.id);

    const emittedName = "appa_gateway_archestra__run_tool";
    const canonicalize = await buildGatewayToolNameCanonicalizer({
      organizationId: org.id,
      declaredToolNames: [emittedName, "appa_gateway_archestra__search_tools"],
    });

    expect(canonicalize(emittedName)).toBe("archestra__run_tool");
    expect(canonicalize.isDeclaredNativeGatewayTool?.(emittedName)).toBe(true);
    expect(
      canonicalize.resolveTrustedGatewayToolTarget?.({
        emittedName,
        targetName: "appa_native_live_fixture__read_source",
      }),
    ).toBe("mcp/appa_gateway/appa_native_live_fixture__read_source");
    expect(
      canonicalize.resolveTrustedGatewayToolTarget?.({
        emittedName,
        targetName: "appa_native_live_fixture__protected_publish",
      }),
    ).toBeUndefined();
  });
});
