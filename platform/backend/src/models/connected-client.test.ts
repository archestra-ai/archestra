import {
  ConnectedClientModel,
  ConnectionSetupModel,
  McpToolCallModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { ConnectionSetupClientId } from "@/types";

describe("ConnectedClientModel", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
  });

  test("lists one entry per redeemed client, ignoring unredeemed setups", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const first = await redeem(user.id, "claude-code", "macos");
    await redeem(user.id, "claude-code", "linux");
    await redeem(user.id, "codex", "macos");
    await setup(user.id, "cursor");

    const clients = await ConnectedClientModel.listForUser({
      organizationId,
      userId: user.id,
    });

    expect(clients.map((c) => c.clientId).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    const claude = clients.find((c) => c.clientId === "claude-code");
    // The latest setup describes the client; the first one dates it.
    expect(claude?.platform).toBe("linux");
    expect(claude?.connectedAt).toEqual(first.consumedAt);
    expect(claude?.lastConnectedAt.getTime()).toBeGreaterThanOrEqual(
      claude?.connectedAt.getTime() ?? 0,
    );
  });

  test("lists the distinct machines a client is connected on, most recent first", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    await redeem(user.id, "claude-code", "macos", "work-laptop");
    await redeem(user.id, "claude-code", "linux");
    await redeem(user.id, "claude-code", "macos", "home-mac");
    await redeem(user.id, "claude-code", "macos", "work-laptop");
    await redeem(user.id, "codex", "macos");

    const clients = await ConnectedClientModel.listForUser({
      organizationId,
      userId: user.id,
    });

    const byId = new Map(clients.map((c) => [c.clientId, c]));
    expect(byId.get("claude-code")?.deviceNames).toEqual([
      "work-laptop",
      "home-mac",
    ]);
    expect(byId.get("codex")?.deviceNames).toEqual([]);
  });

  test("admin list counts recent gateway and LLM proxy use per connected member", async ({
    makeUser,
    makeMember,
    makeAgent,
    makeInteraction,
  }) => {
    const active = await makeUser();
    const idle = await makeUser();
    const never = await makeUser();
    for (const user of [active, idle, never]) {
      await makeMember(user.id, organizationId);
    }
    await redeem(active.id, "claude-code", "macos");
    await redeem(active.id, "codex", "macos");
    await redeem(idle.id, "claude-code", "macos");

    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });
    for (let i = 0; i < 2; i++) {
      await McpToolCallModel.create({
        agentId: gateway.id,
        mcpServerName: "github",
        method: "tools/call",
        toolCall: { id: `${i}`, name: "github__search", arguments: {} },
        toolResult: null,
        userId: active.id,
        authMethod: null,
      });
    }
    await makeInteraction(proxy.id, { userId: active.id });
    // Outside the usage window: not counted.
    await makeInteraction(proxy.id, {
      userId: idle.id,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });

    const { data, pagination } = await ConnectedClientModel.listConnectedUsers({
      organizationId,
      limit: 20,
      offset: 0,
    });

    expect(pagination.total).toBe(2);
    expect(data.map((row) => row.userId).sort()).toEqual(
      [active.id, idle.id].sort(),
    );
    const activeRow = data.find((row) => row.userId === active.id);
    expect(activeRow).toMatchObject({
      email: active.email,
      clientIds: ["claude-code", "codex"],
      gatewayCallCount: 2,
      llmRequestCount: 1,
    });
    expect(activeRow?.lastGatewayCallAt).not.toBeNull();
    expect(data.find((row) => row.userId === idle.id)).toMatchObject({
      gatewayCallCount: 0,
      lastGatewayCallAt: null,
      llmRequestCount: 0,
      lastLlmRequestAt: null,
    });
  });

  async function setup(userId: string, clientId: ConnectionSetupClientId) {
    const { setup: row, rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    return { row, rawToken };
  }

  async function redeem(
    userId: string,
    clientId: ConnectionSetupClientId,
    platform: "macos" | "linux",
    deviceName?: string,
  ) {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform,
      deviceName,
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const claimed = await ConnectionSetupModel.claimByToken({ rawToken });
    if (!claimed) throw new Error("setup was not claimed");
    return claimed;
  }
});
