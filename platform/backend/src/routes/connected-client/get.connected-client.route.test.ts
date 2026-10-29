import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectionSetupModel, OAuthRefreshTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("GET /api/connected-clients", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: routes } = await import("./connected-client.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists only the caller's redeemed clients", async ({
    makeUser,
    makeMember,
  }) => {
    await redeem(user.id, "claude-code");
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    await redeem(other.id, "codex");

    const response = await app.inject({
      method: "GET",
      url: "/api/connected-clients",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ clientId: "claude-code" }),
    ]);
  });

  test("merges a client's setup and its gateway sign-in into one entry", async ({
    makeOAuthClient,
  }) => {
    await redeem(user.id, "claude-code");
    const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
    await makeOAuthClient({ clientId });
    // Signed in to the gateway after the setup was redeemed.
    const signedIn = await OAuthRefreshTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId,
      userId: user.id,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/connected-clients",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      clientId: "claude-code",
      name: "Claude Code",
      lastConnectedAt: expect.any(String),
      deviceNames: [],
      lastSeenAt: null,
    });
    expect(new Date(body[0].lastConnectedAt).getTime()).toBeGreaterThanOrEqual(
      signedIn.createdAt.getTime(),
    );
  });

  test("merges Codex's setup and its per-login CIMD sign-in into one entry", async ({
    makeOAuthClient,
  }) => {
    await redeem(user.id, "codex");
    const clientId = "https://chatgpt.com/oauth/codex/a1b2c3/client.json";
    await makeOAuthClient({ clientId, name: "Codex" });
    await OAuthRefreshTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId,
      userId: user.id,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/connected-clients",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ clientId: "codex", name: "Codex" }),
    ]);
  });

  test("a sign-in counts as a connect when consented, not on each refresh", async ({
    makeOAuthClient,
  }) => {
    const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
    await makeOAuthClient({ clientId });
    const consentedAt = new Date(Date.now() - 3 * DAY_MS);
    await db.insert(schema.oauthConsentsTable).values({
      id: crypto.randomUUID(),
      clientId,
      userId: user.id,
      scopes: ["mcp"],
      createdAt: consentedAt,
    });
    // Refreshed just now, as every launch does.
    await OAuthRefreshTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId,
      userId: user.id,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + 60_000),
    });

    const body = await listClients();

    expect(body).toEqual([
      expect.objectContaining({ clientId: "claude-code" }),
    ]);
    expect(new Date(body[0].lastConnectedAt).getTime()).toBe(
      consentedAt.getTime(),
    );
  });

  test("each client carries when its traffic was last seen", async ({
    makeAgent,
    makeInteraction,
  }) => {
    await redeem(user.id, "claude-code");
    await redeem(user.id, "codex");
    const gateway = await makeAgent({ organizationId });
    await makeInteraction(gateway.id, {
      userId: user.id,
      source: "api",
      externalAgentId: "openai_codex",
      createdAt: new Date(Date.now() - DAY_MS),
    });

    const body = await listClients();

    expect(body.find((c) => c.clientId === "codex")?.lastSeenAt).toEqual(
      expect.any(String),
    );
    expect(body.find((c) => c.clientId === "claude-code")?.lastSeenAt).toBe(
      null,
    );
  });

  test("a call sent with a passthrough key is seen as its author's", async ({
    makeUser,
    makeMember,
    makeAgent,
    makeInteraction,
    makeVirtualApiKey,
  }) => {
    await redeem(user.id, "claude-code");
    await redeem(user.id, "codex");
    const bob = await makeUser();
    await makeMember(bob.id, organizationId);
    const gateway = await makeAgent({ organizationId });
    const userKey = await makeVirtualApiKey(organizationId, {
      authorId: user.id,
    });
    const bobKey = await makeVirtualApiKey(organizationId, {
      authorId: bob.id,
    });
    const authorless = await makeVirtualApiKey(organizationId);
    const codexSeen = new Date(Date.now() - 2 * DAY_MS);
    const claudeSeen = new Date(Date.now() - 3 * DAY_MS);
    // Bob's user header, the user's key: the user's call.
    await makeInteraction(gateway.id, {
      userId: bob.id,
      passthroughVirtualKeyId: userKey.id,
      source: "api",
      externalAgentId: "openai_codex",
      createdAt: codexSeen,
    });
    // The user's header, Bob's key: Bob's call, however recent.
    await makeInteraction(gateway.id, {
      userId: user.id,
      passthroughVirtualKeyId: bobKey.id,
      source: "api",
      externalAgentId: "openai_codex",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    // A key nobody authors leaves the call with its user header.
    await makeInteraction(gateway.id, {
      userId: user.id,
      passthroughVirtualKeyId: authorless.id,
      source: "api",
      externalAgentId: "anthropic_claude_code",
      createdAt: claudeSeen,
    });

    const body = await listClients();

    expect(body.find((c) => c.clientId === "codex")?.lastSeenAt).toBe(
      codexSeen.toISOString(),
    );
    expect(body.find((c) => c.clientId === "claude-code")?.lastSeenAt).toBe(
      claudeSeen.toISOString(),
    );
  });

  test("a signed-in agent is last seen at its newest gateway call", async ({
    makeAgent,
    makeOAuthClient,
  }) => {
    const clientId = "https://claude.ai/oauth/claude-code-client-metadata";
    await makeOAuthClient({ clientId });
    await OAuthRefreshTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId,
      userId: user.id,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    const gateway = await makeAgent({ organizationId });
    const seen = new Date(Date.now() - DAY_MS);
    await db.insert(schema.mcpToolCallsTable).values(
      [new Date(Date.now() - 5 * DAY_MS), seen].map((createdAt) => ({
        agentId: gateway.id,
        mcpServerName: "mcp-gateway",
        method: "tools/call",
        userId: user.id,
        authMethod: "oauth" as const,
        source: "api" as const,
        oauthClientId: clientId,
        createdAt,
      })),
    );

    const body = await listClients();

    expect(body).toEqual([
      expect.objectContaining({
        clientId: "claude-code",
        lastSeenAt: seen.toISOString(),
      }),
    ]);
  });

  // The page used to build the whole adoption report for one member: seven
  // statements, the heaviest scanning months of interactions.
  test("reads the page in three statements", async ({
    makeAgent,
    makeInteraction,
  }) => {
    await redeem(user.id, "codex");
    const gateway = await makeAgent({ organizationId });
    await makeInteraction(gateway.id, {
      userId: user.id,
      source: "api",
      externalAgentId: "openai_codex",
    });

    const query = vi.spyOn(PGlite.prototype, "query");
    try {
      await listClients();
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }
  });

  async function listClients() {
    const response = await app.inject({
      method: "GET",
      url: "/api/connected-clients",
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      clientId: string;
      lastConnectedAt: string;
      lastSeenAt: string | null;
    }[];
  }

  async function redeem(userId: string, clientId: "claude-code" | "codex") {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken });
  }
});
