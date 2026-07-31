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

    const canonicalize = await buildGatewayToolNameCanonicalizer(org.id);

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

    const canonicalize = await buildGatewayToolNameCanonicalizer(org.id);

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

    const canonicalize = await buildGatewayToolNameCanonicalizer(org.id);

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

    const canonicalize = await buildGatewayToolNameCanonicalizer(org.id);

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

    const canonicalize = await buildGatewayToolNameCanonicalizer(org.id);

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

    const canonicalize = await buildGatewayToolNameCanonicalizer(org.id);

    expect(canonicalize("mcp__other_gateway__archestra__run_tool")).toBe(
      "mcp__other_gateway__archestra__run_tool",
    );
  });
});
