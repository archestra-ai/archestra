import crypto from "node:crypto";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { waitForServerInstallation } from "../../utils";
import { expect, test } from "./fixtures";
import {
  callMcpTool,
  getOrgTokenForProfile,
  makeApiRequest,
} from "./mcp-gateway-utils";

/**
 * Inline MCP server script that has a tool to attempt outbound HTTP requests.
 * Used to verify that the NetworkPolicy blocks SSRF attempts from MCP server pods.
 *
 * The `attempt_network_request` tool:
 *   - Takes a `url` parameter
 *   - Tries to fetch that URL using Node.js built-in http/https modules
 *   - Returns "SSRF_BLOCKED: <error>" if the connection fails (expected with NetworkPolicy)
 *   - Returns "SSRF_SUCCESS: <status_code>" if the connection succeeds (unexpected - SSRF vulnerability!)
 *
 * Uses a short 5-second timeout so the test doesn't hang waiting for blocked connections.
 */
const ssrfTestMcpServerScript = `
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const http = require('http');
const https = require('https');
const { z } = require('zod');

const server = new McpServer({ name: 'ssrf-test-server', version: '1.0.0' });

server.tool(
  'attempt_network_request',
  'Attempts an outbound HTTP request to the given URL and reports the result',
  { url: z.string().describe('The URL to attempt to connect to') },
  async ({ url }) => {
    try {
      const result = await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, { timeout: 5000 }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode, body: data.substring(0, 200) });
          });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
        req.on('error', (err) => reject(err));
      });
      return {
        content: [{ type: 'text', text: 'SSRF_SUCCESS: status=' + result.status }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: 'SSRF_BLOCKED: ' + err.message }]
      };
    }
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
`.trim().replace(/\n/g, ' ');

const ssrfTestMcpServerCommand = `npm install --silent @modelcontextprotocol/sdk zod && node -e '${ssrfTestMcpServerScript.replace(/'/g, "'\"'\"'")}'`;

/**
 * SSRF Protection E2E Tests
 *
 * These tests validate that the Kubernetes NetworkPolicy prevents MCP server pods
 * from making outbound connections to private/internal IP ranges, blocking SSRF attacks.
 *
 * The NetworkPolicy (deployed via Helm) targets all pods with label `app: mcp-server`
 * and blocks egress to RFC 1918 ranges, link-local, and loopback addresses while
 * allowing DNS and public internet access.
 *
 * Test approach:
 *   1. Deploy a custom MCP server with a tool that attempts outbound HTTP requests
 *   2. Call the tool with internal/private URLs via the MCP Gateway
 *   3. Verify all connection attempts to private ranges are blocked
 */
test.describe("SSRF Protection - NetworkPolicy for MCP Servers", () => {
  // MCP server installation + tool calls can be slow
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  let catalogId: string;
  let serverId: string;
  let serverName: string;
  let profileId: string;
  let archestraToken: string;

  test.beforeAll(
    async ({
      request,
      createAgent,
      createMcpCatalogItem,
      installMcpServer,
      getTeamByName,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      serverName = `ssrf-test-server-${uniqueSuffix}`;

      // Get the Default Team
      const defaultTeam = await getTeamByName(request, "Default Team");
      if (!defaultTeam) {
        throw new Error("Default Team not found");
      }

      // Create a catalog item for the SSRF test MCP server
      const catalogResponse = await createMcpCatalogItem(request, {
        name: serverName,
        description:
          "MCP server for SSRF protection testing - has a tool that attempts outbound HTTP requests",
        serverType: "local",
        localConfig: {
          command: "sh",
          arguments: ["-c", ssrfTestMcpServerCommand],
          environment: [],
        },
      });
      const catalogItem = await catalogResponse.json();
      catalogId = catalogItem.id;

      // Install the MCP server
      const installResponse = await installMcpServer(request, {
        name: serverName,
        catalogId: catalogItem.id,
        teamId: defaultTeam.id,
      });
      const server = await installResponse.json();
      serverId = server.id;

      // Wait for MCP server to be ready
      await waitForServerInstallation(request, serverId);

      // Create a profile (agent) for MCP gateway access
      const profileResponse = await createAgent(
        request,
        `SSRF Test Profile ${uniqueSuffix}`,
      );
      const profile = await profileResponse.json();
      profileId = profile.id;

      // Assign the SSRF test server's tool to the profile
      // First, discover the tool
      const toolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/mcp_server/${serverId}/tools`,
      });
      const tools = await toolsResponse.json();
      const ssrfTool = tools.find((t: { name: string }) =>
        t.name.includes("attempt_network_request"),
      );
      if (!ssrfTool) {
        throw new Error(
          `Tool 'attempt_network_request' not found. Available tools: ${tools.map((t: { name: string }) => t.name).join(", ")}`,
        );
      }

      // Find the tool entity to assign to profile
      const allToolsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/tools",
      });
      const allTools = await allToolsResponse.json();
      const toolEntity = allTools.find(
        (t: { name: string }) => t.name === ssrfTool.name,
      );
      if (!toolEntity) {
        throw new Error(
          `Tool entity '${ssrfTool.name}' not found in /api/tools`,
        );
      }

      // Assign tool to profile (local MCP server tools require executionSourceMcpServerId)
      await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/agents/${profileId}/tools/${toolEntity.id}`,
        data: { executionSourceMcpServerId: serverId },
      });

      // Get an authentication token for tool calls
      archestraToken = await getOrgTokenForProfile(request);
    },
  );

  test.afterAll(
    async ({
      request,
      deleteAgent,
      deleteMcpCatalogItem,
      uninstallMcpServer,
    }) => {
      // Clean up in reverse order
      if (profileId) await deleteAgent(request, profileId);
      if (serverId) await uninstallMcpServer(request, serverId);
      if (catalogId) await deleteMcpCatalogItem(request, catalogId);
    },
  );

  /**
   * Helper to call the SSRF test tool with a given URL and return the text result.
   */
  async function attemptSsrf(
    request: import("@playwright/test").APIRequestContext,
    targetUrl: string,
  ): Promise<string> {
    const toolName = `${serverName}${MCP_SERVER_TOOL_NAME_SEPARATOR}attempt_network_request`;
    const result = await callMcpTool(request, {
      profileId,
      token: archestraToken,
      toolName,
      arguments: { url: targetUrl },
      timeoutMs: 30_000,
    });

    const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    return textContent?.text || "";
  }

  test("should block SSRF to Kubernetes metadata endpoint (169.254.169.254)", async ({
    request,
  }) => {
    // AWS/GCP/Azure metadata endpoint - a common SSRF target
    const result = await attemptSsrf(
      request,
      "http://169.254.169.254/latest/meta-data/",
    );
    expect(result).toContain("SSRF_BLOCKED");
    expect(result).not.toContain("SSRF_SUCCESS");
  });

  test("should block SSRF to cluster-internal service (10.x range)", async ({
    request,
  }) => {
    // Attempt to reach a typical cluster IP (Kubernetes API server is usually 10.96.0.1)
    const result = await attemptSsrf(request, "http://10.96.0.1:443/");
    expect(result).toContain("SSRF_BLOCKED");
    expect(result).not.toContain("SSRF_SUCCESS");
  });

  test("should block SSRF to private network (192.168.x.x range)", async ({
    request,
  }) => {
    const result = await attemptSsrf(request, "http://192.168.1.1/");
    expect(result).toContain("SSRF_BLOCKED");
    expect(result).not.toContain("SSRF_SUCCESS");
  });

  test("should block SSRF to private network (172.16.x.x range)", async ({
    request,
  }) => {
    const result = await attemptSsrf(request, "http://172.16.0.1/");
    expect(result).toContain("SSRF_BLOCKED");
    expect(result).not.toContain("SSRF_SUCCESS");
  });

  test("should block SSRF to localhost / loopback", async ({ request }) => {
    const result = await attemptSsrf(request, "http://127.0.0.1:9000/health");
    expect(result).toContain("SSRF_BLOCKED");
    expect(result).not.toContain("SSRF_SUCCESS");
  });

  test("should block SSRF to carrier-grade NAT range (100.64.x.x)", async ({
    request,
  }) => {
    const result = await attemptSsrf(request, "http://100.64.0.1/");
    expect(result).toContain("SSRF_BLOCKED");
    expect(result).not.toContain("SSRF_SUCCESS");
  });
});
