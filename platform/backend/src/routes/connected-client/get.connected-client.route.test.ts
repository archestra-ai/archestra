import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectionSetupModel, OAuthRefreshTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

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
      lastConnectedAt: expect.any(String),
      deviceNames: [],
    });
    expect(new Date(body[0].lastConnectedAt).getTime()).toBeGreaterThanOrEqual(
      signedIn.createdAt.getTime(),
    );
  });

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
