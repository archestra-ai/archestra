import { vi } from "vitest";

vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    restartServer: vi.fn(),
    getOrLoadDeployment: vi.fn(),
    reinstallSharedDeployment: vi.fn(),
    ensureAwake: vi.fn(),
    isDeploymentDormant: vi.fn(() => false),
    registerHibernationListener: vi.fn(),
  },
  McpServerWakeError: class McpServerWakeError extends Error {},
}));

vi.mock("@/websocket", () => ({
  broadcastMcpInstallationStatus: vi.fn(),
}));

import { TOOL_SEARCH_TOOLS_FULL_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import db, { schema } from "@/database";
import { AgentModel, McpServerModel, ToolModel } from "@/models";
import { buildAgentMcpToolList } from "@/routes/mcp-gateway/utils";
import { beforeEach, describe, expect, test } from "@/test";
import type { McpServer } from "@/types";
import { reloadToolsForServer } from "./mcp-reinstall";
import { backfillMcpToolDescriptions } from "./mcp-tool-description-backfill";

// The upstream server describes its tool for the account each installation
// authenticated as, the way some hosted servers name the signed-in user.
function describeFor(ownerId: string | null) {
  return `Searches messages. The signed-in user's id is ${ownerId}.`;
}

beforeEach(() => {
  config.openappa.enabled = false;
  vi.spyOn(McpServerModel, "getToolsFromServer").mockImplementation(
    async (server) => [
      {
        name: "search_messages",
        description: describeFor((server as McpServer).ownerId),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  );
});

describe("per-installation tool descriptions", () => {
  test("each caller's gateway tools/list describes the tool as their own installation does", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { org, alice, bob, aliceInstall, bobInstall, tool } =
      await seedTwoPersonalInstalls({
        makeUser,
        makeOrganization,
        makeMember,
        makeInternalMcpCatalog,
        makeMcpServer,
      });
    // Bob synced last, so the shared row now carries Bob's text.
    await reloadToolsForServer(aliceInstall);
    await reloadToolsForServer(bobInstall);

    const agent = await makeAgent({
      organizationId: org.id,
      // List third-party tools directly rather than behind search_tools.
      toolExposureMode: "full",
    });
    await makeAgentTool(agent.id, (await tool()).id, {
      credentialResolutionMode: "dynamic",
    });
    const gateway = await AgentModel.findGatewayAgentById(agent.id);
    if (!gateway) throw new Error("gateway agent not found");

    const listFor = async (userId: string) => {
      const { tools } = await buildAgentMcpToolList({
        agent: gateway,
        tokenAuth: { userId, organizationId: org.id },
      });
      return tools.find((listed) => listed.name.endsWith("search_messages"))
        ?.description;
    };

    const aliceSees = await listFor(alice.id);
    expect(aliceSees).toContain(describeFor(alice.id));
    expect(aliceSees).not.toContain(bob.id);
    expect(await listFor(bob.id)).toContain(describeFor(bob.id));
  });

  test("a tool pinned to one installation is described as that installation does, for every caller", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { org, alice, bob, aliceInstall, bobInstall, tool } =
      await seedTwoPersonalInstalls({
        makeUser,
        makeOrganization,
        makeMember,
        makeInternalMcpCatalog,
        makeMcpServer,
      });
    await reloadToolsForServer(aliceInstall);
    await reloadToolsForServer(bobInstall);

    // Calls run through Alice's installation whoever makes them.
    const agent = await makeAgent({
      organizationId: org.id,
      // List third-party tools directly rather than behind search_tools.
      toolExposureMode: "full",
    });
    await makeAgentTool(agent.id, (await tool()).id, {
      credentialResolutionMode: "static",
      mcpServerId: aliceInstall.id,
    });
    const gateway = await AgentModel.findGatewayAgentById(agent.id);
    if (!gateway) throw new Error("gateway agent not found");

    const { tools } = await buildAgentMcpToolList({
      agent: gateway,
      tokenAuth: { userId: bob.id, organizationId: org.id },
    });
    const listed = tools.find((entry) =>
      entry.name.endsWith("search_messages"),
    );
    expect(listed?.description).toContain(describeFor(alice.id));
  });

  test("search_tools describes the tool as the caller's own installation does", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMcpServer,
    seedAndAssignArchestraTools,
  }) => {
    const { org, alice, bob, aliceInstall, bobInstall, tool } =
      await seedTwoPersonalInstalls({
        makeUser,
        makeOrganization,
        makeMember,
        makeInternalMcpCatalog,
        makeMcpServer,
      });
    await reloadToolsForServer(aliceInstall);
    await reloadToolsForServer(bobInstall);

    const agent = await makeAgent({ organizationId: org.id });
    await seedAndAssignArchestraTools(agent.id);
    await makeAgentTool(agent.id, (await tool()).id, {
      credentialResolutionMode: "dynamic",
    });

    const result = await executeArchestraTool(
      TOOL_SEARCH_TOOLS_FULL_NAME,
      { query: "search messages" },
      {
        agent: { id: agent.id, name: agent.name },
        agentId: agent.id,
        organizationId: org.id,
        userId: alice.id,
        tokenAuth: {
          tokenId: "test-token",
          teamId: null,
          isOrganizationToken: false,
          userId: alice.id,
          organizationId: org.id,
        },
      },
    );

    expect(result.isError).toBe(false);
    const { tools } = result.structuredContent as {
      tools: Array<{ toolName: string; description: string | null }>;
    };
    const found = tools.find((entry) =>
      entry.toolName.endsWith("search_messages"),
    );
    expect(found?.description).toBe(describeFor(alice.id));
    expect(found?.description).not.toContain(bob.id);
  });

  test("an installation that stops reporting a tool no longer supplies its description", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { aliceInstall, tool } = await seedTwoPersonalInstalls({
      makeUser,
      makeOrganization,
      makeMember,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    await reloadToolsForServer(aliceInstall);
    const { id: toolId } = await tool();

    vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([
      {
        name: "other_tool",
        description: "Another tool.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    await reloadToolsForServer(aliceInstall);

    const recorded = await db
      .select()
      .from(schema.mcpServerToolDescriptionsTable)
      .where(
        eq(schema.mcpServerToolDescriptionsTable.mcpServerId, aliceInstall.id),
      );
    expect(recorded.map((row) => row.toolId)).not.toContain(toolId);
    expect(recorded).toHaveLength(1);
  });
});

describe("backfill of installations that predate per-installation descriptions", () => {
  test("records each existing installation's own description without touching the shared rows", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const { org, alice, bob, catalog } = await seedTwoPersonalInstalls({
      makeUser,
      makeOrganization,
      makeMember,
      makeInternalMcpCatalog,
      makeMcpServer,
    });
    // As before the upgrade: the shared rows hold Bob's text and an extra
    // tool only Bob's installation reports; nothing is recorded per
    // installation.
    const [shared, bobOnly] = await ToolModel.bulkCreateToolsIfNotExists([
      {
        name: ToolModel.slugifyName(catalog.name, "search_messages"),
        rawToolName: "search_messages",
        description: describeFor(bob.id),
        parameters: { type: "object", properties: {} },
        catalogId: catalog.id,
      },
      {
        name: ToolModel.slugifyName(catalog.name, "bob_only"),
        rawToolName: "bob_only",
        description: "Only Bob's installation reports this.",
        parameters: { type: "object", properties: {} },
        catalogId: catalog.id,
      },
    ]);

    await backfillMcpToolDescriptions();

    const agent = await makeAgent({
      organizationId: org.id,
      toolExposureMode: "full",
    });
    await makeAgentTool(agent.id, shared.id, {
      credentialResolutionMode: "dynamic",
    });
    const gateway = await AgentModel.findGatewayAgentById(agent.id);
    if (!gateway) throw new Error("gateway agent not found");
    const listFor = async (userId: string) => {
      const { tools } = await buildAgentMcpToolList({
        agent: gateway,
        tokenAuth: { userId, organizationId: org.id },
      });
      return tools.find((listed) => listed.name.endsWith("search_messages"))
        ?.description;
    };

    expect(await listFor(alice.id)).toContain(describeFor(alice.id));
    expect(await listFor(bob.id)).toContain(describeFor(bob.id));
    // The shared rows are left exactly as they were.
    const rows = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalog.id));
    expect(rows.map((row) => row.id).sort()).toEqual(
      [shared.id, bobOnly.id].sort(),
    );
    expect(rows.find((row) => row.id === shared.id)?.description).toBe(
      describeFor(bob.id),
    );
  });
});

// =============================================================================
// Internal helpers
// =============================================================================

async function seedTwoPersonalInstalls(fixtures: {
  makeUser: (overrides?: { email?: string }) => Promise<{ id: string }>;
  makeOrganization: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides?: { role?: string },
  ) => Promise<unknown>;
  makeInternalMcpCatalog: (overrides: {
    name: string;
    serverType: "remote";
    organizationId: string;
  }) => Promise<{ id: string; name: string }>;
  makeMcpServer: (overrides: {
    name: string;
    catalogId: string;
    ownerId: string;
    serverType: "remote";
  }) => Promise<McpServer>;
}) {
  const org = await fixtures.makeOrganization();
  const alice = await fixtures.makeUser({ email: "alice@example.com" });
  const bob = await fixtures.makeUser({ email: "bob@example.com" });
  await fixtures.makeMember(alice.id, org.id, { role: "admin" });
  await fixtures.makeMember(bob.id, org.id, { role: "admin" });
  const catalog = await fixtures.makeInternalMcpCatalog({
    name: "messaging",
    serverType: "remote",
    organizationId: org.id,
  });
  const install = (ownerId: string) =>
    fixtures.makeMcpServer({
      name: "messaging",
      catalogId: catalog.id,
      ownerId,
      serverType: "remote",
    });
  const aliceInstall = await install(alice.id);
  const bobInstall = await install(bob.id);
  // The shared row for the tool, once a sync has created it.
  const tool = async () => {
    const [row] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalog.id));
    if (!row) throw new Error("tool not synced");
    return row;
  };
  return { org, alice, bob, catalog, aliceInstall, bobInstall, tool };
}
