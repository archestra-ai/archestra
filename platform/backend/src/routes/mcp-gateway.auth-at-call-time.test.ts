/**
 * MCP Gateway — auth at call time.
 *
 * Ported from the `mcp-gateway-auth-at-call-time.spec.ts` e2e. Exercises the
 * "resolve at call time" credential-resolution flow entirely against the DB +
 * gateway routing (no remote MCP server is ever contacted — dynamic resolution
 * short-circuits to an auth-required error before any network call, so the
 * e2e's WireMock remote stub is unnecessary here):
 *
 *  1. An admin installs a remote MCP server (personal scope, no team).
 *  2. A tool from that catalog is assigned to a gateway agent with dynamic
 *     credential resolution.
 *  3. A team token (for a team the admin's personal install is not shared with)
 *     calls the tool.
 *  4. The gateway returns an auth-required result carrying a self-service
 *     install URL for the catalog item.
 */

import {
  getArchestraToolFullName,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { TeamTokenModel, UserTokenModel } from "@/models";
import McpServerUserModel from "@/models/mcp-server-user";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./mcp-gateway";

const CATALOG_NAME = "auth-calltime-test";
const FULL_TOOL_NAME = `${CATALOG_NAME}__test_auth_tool`;

function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

describe("MCP Gateway - Auth at Call Time", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns auth-required error with install URL when caller has no matching credential", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();

    // Admin owns the credential; a separate team (that the admin is NOT in) is
    // the caller.
    const admin = await makeUser();
    await makeMember(admin.id, org.id);
    const teamOwner = await makeUser();
    await makeMember(teamOwner.id, org.id);
    const marketingTeam = await makeTeam(org.id, teamOwner.id, {
      name: "Marketing",
    });

    // Remote catalog item + a tool exposed by it.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: CATALOG_NAME,
      serverType: "remote",
      serverUrl: "https://remote.example.com/mcp",
      scope: "org",
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: FULL_TOOL_NAME,
    });

    // Admin's personal install (no team): present but NOT shared with the
    // Marketing team, so it must not be picked for the team token.
    await makeMcpServer({
      catalogId: catalog.id,
      ownerId: admin.id,
      scope: "personal",
      teamId: null,
    });

    // Gateway agent assigned to the Marketing team, exposing the tool with
    // dynamic credential resolution.
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      scope: "team",
      teams: [marketingTeam.id],
      toolExposureMode: "full",
      accessAllTools: false,
    });
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });

    // Marketing team token (personal/team token, not org-wide).
    const { value: marketingTeamToken } = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Marketing Token",
      teamId: marketingTeam.id,
      isOrganizationToken: false,
    });

    // Stateless mode requires an initialize before a tools/call.
    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(marketingTeamToken),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
    expect(initResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(marketingTeamToken),
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: FULL_TOOL_NAME, arguments: {} },
      },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();

    // Auth-required is returned as a JSON-RPC result (not error) with isError.
    expect(result).toHaveProperty("result");
    expect(result.result.isError).toBe(true);

    const textContent = result.result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("Authentication required for");
    expect(textContent.text).toContain(CATALOG_NAME);
    expect(textContent.text).toContain("/mcp/registry?install=");
    expect(textContent.text).toContain(catalog.id);
  });

  // Dynamic ("all tools") discovery counterpart: the tool is NOT assigned to
  // the agent and the caller has no connection of their own — another user's
  // personal connection is the catalog's only install. The tool must still be
  // reachable through run_tool, with the auth-required setup prompt returned
  // at call time (previously the tool silently did not exist for the caller,
  // so nothing ever told them to connect).
  test("run_tool on an unconnected per-user catalog returns the auth-required setup prompt", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTool,
  }) => {
    const org = await makeOrganization();

    // Another org member has connected; the caller has not.
    const connectedUser = await makeUser();
    await makeMember(connectedUser.id, org.id);
    const caller = await makeUser();
    await makeMember(caller.id, org.id, { role: "admin" });

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "per-user-oauth-test",
      serverType: "remote",
      serverUrl: "https://remote.example.com/mcp",
      scope: "org",
    });
    const toolName = "per-user-oauth-test__list_issues";
    await makeTool({ catalogId: catalog.id, name: toolName });

    const otherInstall = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: connectedUser.id,
      scope: "personal",
      teamId: null,
    });
    await McpServerUserModel.assignUserToMcpServer(
      otherInstall.id,
      connectedUser.id,
    );

    // All-tools agent; the tool has no agent_tools assignment.
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      accessAllTools: true,
    });

    const { value: callerToken } = await UserTokenModel.create(
      caller.id,
      org.id,
      "Caller Token",
    );

    const initResponse = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(callerToken),
      payload: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
        id: 1,
      },
    });
    expect(initResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(callerToken),
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: getArchestraToolFullName(TOOL_RUN_TOOL_SHORT_NAME),
          arguments: { tool_name: toolName, tool_args: {} },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result).toHaveProperty("result");
    expect(result.result.isError).toBe(true);

    const textContent = result.result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    // The actionable auth prompt — not the "tool unavailable" recovery text.
    expect(textContent.text).toContain("Authentication required for");
    expect(textContent.text).toContain("/mcp/registry?install=");
    expect(textContent.text).toContain(catalog.id);
  });
});
