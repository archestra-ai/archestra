import {
  MARKETING_TEAM_NAME,
  MCP_GATEWAY_URL_SUFFIX,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  WIREMOCK_INTERNAL_URL,
} from "../../consts";
import { expect, test } from "./fixtures";
import {
  getTeamTokenForProfile,
  makeApiRequest,
  makeMcpGatewayRequestHeaders,
} from "./mcp-gateway-utils";

/**
 * MCP Gateway - Auth at Call Time Tests
 *
 * Tests the "Resolve at call time" credential resolution flow:
 * 1. Admin installs a remote MCP server (owns the credential)
 * 2. A tool is assigned to a profile with useDynamicTeamCredential: true
 * 3. A team token (for a team admin is NOT in) is used to call the tool
 * 4. The gateway returns an auth-required error with an install URL
 *
 * Uses static WireMock mappings (helm/e2e-tests/mappings/mcp-auth-calltime-e2e-*.json)
 * as a mock remote MCP server for tool discovery.
 */
test.describe("MCP Gateway - Auth at Call Time", () => {
  const CATALOG_NAME = "auth-calltime-e2e";
  const MCP_TOOL_BASE_NAME = "test_auth_tool";
  const FULL_TOOL_NAME = `${CATALOG_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${MCP_TOOL_BASE_NAME}`;
  const WIREMOCK_MCP_PATH = `/mcp/${CATALOG_NAME}`;

  let catalogItemId: string;
  let serverId: string;
  let profileId: string;
  let marketingTeamToken: string;

  test.beforeAll(
    async ({
      request,
      createAgent,
      createMcpCatalogItem,
      installMcpServer,
      getTeamByName,
    }) => {
      // 1. Create remote catalog item pointing to WireMock (static stubs pre-loaded)
      const catalogResponse = await createMcpCatalogItem(request, {
        name: CATALOG_NAME,
        description: "Test server for auth-at-call-time e2e test",
        serverType: "remote",
        serverUrl: `${WIREMOCK_INTERNAL_URL}${WIREMOCK_MCP_PATH}`,
      });
      const catalog = await catalogResponse.json();
      catalogItemId = catalog.id;

      // 2. Install server as admin (personal install, no team)
      const installResponse = await installMcpServer(request, {
        name: CATALOG_NAME,
        catalogId: catalogItemId,
      });
      const server = await installResponse.json();
      serverId = server.id;

      // 3. Wait for tool discovery (poll for the tool to appear)
      let discoveredTool: { id: string; name: string } | undefined;
      for (let attempt = 0; attempt < 30; attempt++) {
        const toolsResponse = await makeApiRequest({
          request,
          method: "get",
          urlSuffix: "/api/tools",
        });
        const toolsData = await toolsResponse.json();
        const tools = Array.isArray(toolsData)
          ? toolsData
          : (toolsData.data ?? []);
        discoveredTool = tools.find(
          (t: { name: string }) => t.name === FULL_TOOL_NAME,
        );
        if (discoveredTool) break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!discoveredTool) {
        throw new Error(
          `Tool '${FULL_TOOL_NAME}' not discovered after 60 seconds. ` +
            `Check WireMock stubs at ${WIREMOCK_MCP_PATH}`,
        );
      }

      // 4. Get Marketing Team (admin is NOT a member of this team)
      const marketingTeam = await getTeamByName(request, MARKETING_TEAM_NAME);

      // 5. Create profile and assign Marketing Team so the team token can access it
      const profileResponse = await createAgent(request, `Auth Call Time Test`);
      const profile = await profileResponse.json();
      profileId = profile.id;

      await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/agents/${profileId}`,
        data: { teams: [marketingTeam.id] },
      });

      // 6. Assign tool to profile with useDynamicTeamCredential: true
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/agents/${profileId}/tools/${discoveredTool.id}`,
        data: { useDynamicTeamCredential: true },
      });

      // 7. Get Marketing Team token
      marketingTeamToken = await getTeamTokenForProfile(
        request,
        MARKETING_TEAM_NAME,
      );
    },
  );

  test.afterAll(async ({ request, deleteAgent, deleteMcpCatalogItem }) => {
    // Clean up resources (ignore errors to avoid masking test failures)
    if (profileId) {
      await deleteAgent(request, profileId).catch(() => {});
    }
    if (serverId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/mcp_server/${serverId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
    if (catalogItemId) {
      await deleteMcpCatalogItem(request, catalogItemId).catch(() => {});
    }
  });

  test("returns auth-required error with install URL when caller has no matching credential", async ({
    request,
  }) => {
    // Call tool via MCP gateway with Marketing Team token.
    // Admin owns the installed server but is NOT in Marketing Team.
    // Dynamic credential resolution finds no matching server -> auth-required error.
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(marketingTeamToken),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: FULL_TOOL_NAME,
          arguments: {},
        },
      },
    });

    expect(response.status()).toBe(200);
    const result = await response.json();

    // Auth-required is returned as a JSON-RPC result (not error) with isError flag
    expect(result).toHaveProperty("result");
    expect(result.result.isError).toBe(true);

    // Verify error content contains actionable information
    const textContent = result.result.content.find(
      // biome-ignore lint/suspicious/noExplicitAny: e2e test
      (c: any) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect(textContent.text).toContain("Authentication required for");
    expect(textContent.text).toContain(CATALOG_NAME);
    expect(textContent.text).toContain("/mcp-catalog/registry?install=");
    expect(textContent.text).toContain(catalogItemId);
  });
});
