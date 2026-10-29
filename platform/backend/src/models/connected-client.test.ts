import db, { schema } from "@/database";
import { ConnectedClientModel, ConnectionSetupModel } from "@/models";
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

    const clients = await ConnectedClientModel.listRedeemedForUser({
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

    const clients = await ConnectedClientModel.listRedeemedForUser({
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

  test("logs a sign-in-only agent's connect and disconnect from its audit entry", async ({
    makeUser,
    makeMember,
    makeAgent,
    makeOAuthClient,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const connectedAt = new Date("2026-10-07T15:45:05.000Z");
    const disconnectedAt = new Date("2026-10-07T15:49:14.874Z");
    // The gateway its connect added: the first one it called meanwhile.
    const gateway = await makeAgent({ organizationId, name: "My Gateway" });
    const amp = await makeOAuthClient({
      name: "Amp MCP Client (archestra)",
      redirectUris: ["http://localhost:41592/oauth/callback"],
    });
    await db.insert(schema.mcpToolCallsTable).values({
      agentId: gateway.id,
      userId: user.id,
      oauthClientId: amp.clientId,
      mcpServerName: "github",
      method: "tools/call",
      createdAt: new Date("2026-10-07T15:46:00.000Z"),
    });
    await auditDisconnect(user.id, disconnectedAt, {
      clientId: "amp",
      platform: null,
      mcpGatewayId: null,
      llmProxyId: null,
      connectedAt: connectedAt.toISOString(),
    });
    // A setup disconnect is logged from its setups, not its audit entry.
    await auditDisconnect(user.id, disconnectedAt, {
      clientId: "cursor",
      platform: "macos",
      mcpGatewayId: null,
      llmProxyId: null,
      connectedAt: connectedAt.toISOString(),
    });

    const { data } = await ConnectedClientModel.listEvents({
      organizationId,
      pagination: { limit: 10 },
    });

    expect(
      data.map((e) => [e.action, e.occurredAt, e.clientId, e.agentName, e.via]),
    ).toEqual([
      ["disconnected", disconnectedAt, "amp", "Amp", "oauthSignIn"],
      ["connected", connectedAt, "amp", "Amp", "oauthSignIn"],
    ]);
    expect(data[0].userId).toBe(user.id);
    expect(data[0].mcpGateway).toBeNull();
    expect(data[1].mcpGateway).toEqual({ id: gateway.id, name: "My Gateway" });
  });

  test("names the gateway and LLM proxy a setup added, and counts its skills", async ({
    makeUser,
    makeMember,
    makeAgent,
    makeSkill,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const gateway = await makeAgent({ organizationId, name: "Tools" });
    const proxy = await makeAgent({ organizationId, name: "Proxy" });
    const zeta = await makeSkill(organizationId, { name: "zeta" });
    const alpha = await makeSkill(organizationId, { name: "alpha" });
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId: user.id,
      clientId: "codex",
      platform: "macos",
      mcpGatewayId: gateway.id,
      llmProxyId: proxy.id,
      includeSkills: true,
      skillIds: [zeta.id, alpha.id],
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken });

    const { data } = await ConnectedClientModel.listEvents({
      organizationId,
      pagination: { limit: 10 },
    });

    expect(data[0]).toMatchObject({
      mcpGateway: { id: gateway.id, name: "Tools" },
      llmProxy: { id: proxy.id, name: "Proxy" },
      includeSkills: true,
      skillCount: 2,
    });
  });

  async function auditDisconnect(
    userId: string,
    occurredAt: Date,
    client: Record<string, unknown>,
  ) {
    await db.insert(schema.auditLogsTable).values({
      organizationId,
      occurredAt,
      actorId: userId,
      actorType: "user",
      action: "connectedClient.disconnected",
      outcome: "success",
      resourceType: "connectedClient",
      resourceId: userId,
      before: { userId, deviceNames: [], ...client },
    });
  }

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
    // Redeems in one millisecond tie on consumedAt, and the list orders by it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const claimed = await ConnectionSetupModel.claimByToken({ rawToken });
    if (!claimed) throw new Error("setup was not claimed");
    return claimed;
  }
});
