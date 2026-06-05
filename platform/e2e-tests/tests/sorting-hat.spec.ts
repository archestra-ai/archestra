import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@archestra/shared";
import { MCP_GATEWAY_URL_SUFFIX, WIREMOCK_INTERNAL_URL } from "../consts";
import {
  getOrgTokenForProfile,
  makeApiRequest,
  makeMcpGatewayRequestHeaders,
} from "../utils/mcp-gateway";
import { expect, test } from "./api-fixtures";

test.describe("Sorting Hat MCP gateway flow", () => {
  test.setTimeout(120_000);

  const CATALOG_NAME = "sorting-hat-e2e";
  const MCP_TOOL_BASE_NAME = "run_health_probe";
  const FULL_TOOL_NAME = `${CATALOG_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${MCP_TOOL_BASE_NAME}`;
  const WIREMOCK_MCP_PATH = `/mcp/${CATALOG_NAME}`;

  let catalogItemId: string;
  let serverId: string;
  let profileId: string;
  let orgToken: string;

  test.beforeAll(async ({ request }) => {
    const catalogResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/internal_mcp_catalog",
      data: {
        name: CATALOG_NAME,
        description: "Sorting Hat E2E MCP server",
        serverType: "remote",
        serverUrl: `${WIREMOCK_INTERNAL_URL}${WIREMOCK_MCP_PATH}`,
      },
    });
    const catalog = await catalogResponse.json();
    catalogItemId = catalog.id;

    const installResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server",
      data: { name: CATALOG_NAME, catalogId: catalogItemId },
    });
    const server = await installResponse.json();
    serverId = server.id;

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
        (tool: { name: string }) => tool.name === FULL_TOOL_NAME,
      );
      if (discoveredTool) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!discoveredTool) {
      throw new Error(
        `Tool '${FULL_TOOL_NAME}' not discovered after 60 seconds. Check WireMock stubs at ${WIREMOCK_MCP_PATH}`,
      );
    }

    const profileResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/agents",
      data: {
        name: "Sorting Hat E2E",
        teams: [],
        agentType: "mcp_gateway",
        scope: "org",
      },
    });
    const profile = await profileResponse.json();
    profileId = profile.id;

    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/agents/${profileId}/tools/${discoveredTool.id}`,
      data: { mcpServerId: serverId },
    });

    orgToken = await getOrgTokenForProfile(request);
  });

  test.afterAll(async ({ request }) => {
    if (profileId) {
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/agents/${profileId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
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
      await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/internal_mcp_catalog/${catalogItemId}`,
        ignoreStatusCheck: true,
      }).catch(() => {});
    }
  });

  test("sorts and annotates a Gryffindor tool call", async ({ request }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `${MCP_GATEWAY_URL_SUFFIX}/${profileId}`,
      headers: makeMcpGatewayRequestHeaders(orgToken),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: FULL_TOOL_NAME, arguments: {} },
      },
    });
    const body = await response.json();

    expect(body.result.content[0].text).toBe("probe complete");
    expect(body.result._meta.sortingHat.house).toBe("gryffindor");
    expect(body.result._meta.sortingHat.monologue.length).toBeGreaterThan(0);
    expect(body.result._meta.sortingHat.floo.greenFlameParticles).toBe(true);
  });

  test("streams Sorting Hat and Quidditch progress events", async ({
    request,
  }) => {
    const sortStream = await makeApiRequest({
      request,
      method: "get",
      urlSuffix:
        "/api/sorting-hat/sort/stream?toolName=run_health_probe&toolDescription=Run%20an%20operational%20health%20probe",
    });
    const sortText = await sortStream.text();
    expect(sortText).toContain("event: monologue");
    expect(sortText).toContain("event: complete");
    expect(sortText).toContain("gryffindor");

    const quidditchStream = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/sorting-hat/quidditch/e2e-tool-call",
    });
    const quidditchText = await quidditchStream.text();
    expect(quidditchText).toContain("event: snitch-progress");
    expect(quidditchText).toContain("event: complete");
  });
});
