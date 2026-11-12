import { randomUUID } from "node:crypto";
import AgentToolModel from "@/models/agent-tool";
import ToolModel from "@/models/tool";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { afterEach, describe, expect, type TestFixtures, test } from "@/test";
import {
  connectTestDevice,
  runTestTunnelClient,
  waitUntilOnline,
} from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import { agentOwner } from "@/types";
import mcpClient, { type TokenAuthContext } from "./mcp-client";

/**
 * A tool call on a desktop MCP server always runs on the caller's own
 * computer, whatever installation the agent's tool is set to.
 */
describe("tool calls on a desktop MCP server", () => {
  const ctx = useRouteTestApp(desktopTunnelRoutes);
  const stops: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await mcpClient.disconnectAll();
    for (const stop of stops.splice(0)) await stop();
  });

  /** A device of the user whose tunnel client records the tool calls. */
  async function runDevice(userId: string, catalogId: string) {
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId,
    });
    const calls: unknown[] = [];
    const client = runTestTunnelClient({
      app: ctx.app,
      device,
      readyChannels: [catalogId],
      answer: ({ method, params }) => {
        if (method === "initialize") {
          return {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "files", version: "1.0.0" },
          };
        }
        if (method === "tools/call") {
          calls.push(params);
          return { content: [{ type: "text", text: `ran for ${userId}` }] };
        }
        return {};
      },
    });
    stops.push(client.stop);
    await waitUntilOnline(device.device.id);
    return calls;
  }

  function call(agentId: string, tokenAuth: TokenAuthContext) {
    return mcpClient.executeToolCallForOwner(
      { id: `call_${randomUUID()}`, name: "files__read_file", arguments: {} },
      agentOwner(agentId),
      tokenAuth,
    );
  }

  function userToken(userId: string): TokenAuthContext {
    return {
      tokenId: "token",
      teamId: null,
      isOrganizationToken: false,
      userId,
    };
  }

  async function setUp(
    fixtures: Pick<
      TestFixtures,
      | "makeInternalMcpCatalog"
      | "makeMcpServer"
      | "makeAgent"
      | "makeMember"
      | "makeUser"
    >,
  ) {
    const owner = ctx.user;
    const caller = await fixtures.makeUser();
    for (const user of [owner, caller]) {
      await fixtures.makeMember(user.id, ctx.organizationId);
    }
    const catalog = await fixtures.makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "files",
      serverType: "desktop_mcp",
      desktopConfig: { command: "/opt/files/mcp" },
    });
    const ownerInstall = await fixtures.makeMcpServer({
      catalogId: catalog.id,
      serverType: "desktop_mcp",
      scope: "personal",
      ownerId: owner.id,
      localInstallationStatus: "success",
    });
    const tool = await ToolModel.createToolIfNotExists({
      name: "files__read_file",
      description: "Reads a file",
      parameters: {},
      catalogId: catalog.id,
    });
    // The agent's tool is set to the owner's installation.
    const agent = await fixtures.makeAgent({
      organizationId: ctx.organizationId,
    });
    await AgentToolModel.create(agent.id, tool.id, {
      mcpServerId: ownerInstall.id,
      credentialResolutionMode: "static",
    });
    return { owner, caller, catalog, agent };
  }

  test("runs on the caller's computer through the caller's installation, not the one the tool is set to", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const { owner, caller, catalog, agent } = await setUp({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeAgent,
      makeMember,
      makeUser,
    });
    await makeMcpServer({
      catalogId: catalog.id,
      serverType: "desktop_mcp",
      scope: "personal",
      ownerId: caller.id,
      localInstallationStatus: "success",
    });
    const ownerCalls = await runDevice(owner.id, catalog.id);
    const callerCalls = await runDevice(caller.id, catalog.id);

    const result = await call(agent.id, userToken(caller.id));

    expect(result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: `ran for ${caller.id}` }],
    });
    expect(callerCalls).toHaveLength(1);
    expect(ownerCalls).toEqual([]);
  });

  test("a caller with no installation is asked to add it to their computer, and nothing reaches another computer", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const { owner, caller, catalog, agent } = await setUp({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeAgent,
      makeMember,
      makeUser,
    });
    const ownerCalls = await runDevice(owner.id, catalog.id);

    const result = await call(agent.id, userToken(caller.id));

    // Desktop wording, not credentials: the link opens the registry on the
    // dialog that adds the server to the caller's computer.
    const addUrl = expect.stringContaining(
      `/mcp/registry?install=${catalog.id}`,
    );
    expect(result).toMatchObject({
      isError: true,
      _meta: {
        archestraError: {
          type: "auth_required",
          action: "add_desktop_mcp_server",
          catalogId: catalog.id,
          catalogName: "files",
          actionUrl: addUrl,
        },
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain('"files" is not connected from your device.');
    expect(text).toMatch(
      /To connect "files" from your device, visit this URL: \S+\/mcp\/registry\?install=/,
    );
    expect(text).not.toMatch(/credentials|install it|Authentication required/i);
    expect(ownerCalls).toEqual([]);
  });

  test("a call with no user is refused", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const { owner, catalog, agent } = await setUp({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeAgent,
      makeMember,
      makeUser,
    });
    const ownerCalls = await runDevice(owner.id, catalog.id);

    const result = await call(agent.id, {
      tokenId: "token",
      teamId: null,
      isOrganizationToken: true,
    });

    expect(result.isError).toBe(true);
    expect(ownerCalls).toEqual([]);
  });
});
