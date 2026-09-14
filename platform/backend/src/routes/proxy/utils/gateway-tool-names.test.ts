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
});
