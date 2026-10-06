import { withDbTransaction } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import {
  ConnectedClientModel,
  ConnectionSetupModel,
  OAuthAccessTokenModel,
  OAuthRefreshTokenModel,
  SkillShareLinkModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const CLAUDE_CODE_OAUTH_CLIENT_ID =
  "https://claude.ai/oauth/claude-code-client-metadata";

describe("DELETE /api/connected-clients/:clientId", () => {
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

  test("drops the client, revokes its gateway grant and share link, and leaves everything else", async ({
    makeUser,
    makeMember,
    makeOAuthClient,
    makeSkill,
  }) => {
    const setupId = await redeem(user.id, "claude-code");
    await redeem(user.id, "codex");
    const skill = await makeSkill(organizationId, { authorId: user.id });
    const { link } = await SkillShareLinkModel.create({
      organizationId,
      createdByUserId: user.id,
      skillIds: [skill.id],
      marketplaceName: "test",
    });
    await withDbTransaction((tx) =>
      ConnectionSetupModel.attachSkillShareLink({
        connectionSetupId: setupId,
        skillShareLinkId: link.id,
        tx,
      }),
    );

    await makeOAuthClient({ clientId: CLAUDE_CODE_OAUTH_CLIENT_ID });
    const unrelated = await makeOAuthClient();
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    const refresh = await token(user.id, CLAUDE_CODE_OAUTH_CLIENT_ID);
    // An access token not minted from a refresh token.
    await OAuthAccessTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId: CLAUDE_CODE_OAUTH_CLIENT_ID,
      userId: user.id,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const kept = [
      await token(user.id, unrelated.clientId),
      await token(other.id, CLAUDE_CODE_OAUTH_CLIENT_ID),
    ];

    const response = await app.inject({
      method: "DELETE",
      url: "/api/connected-clients/claude-code",
    });

    expect(response.statusCode).toBe(200);
    // The refresh token and both access tokens.
    expect(response.json()).toEqual({
      setups: 1,
      oauthClients: 1,
      tokens: 3,
      shareLinks: 1,
    });
    const remaining = await ConnectedClientModel.listForUser({
      organizationId,
      userId: user.id,
    });
    expect(remaining.map((c) => c.clientId)).toEqual(["codex"]);
    expect(await OAuthRefreshTokenModel.getById(refresh.id)).toBeNull();
    for (const row of kept) {
      expect(await OAuthRefreshTokenModel.getById(row.id)).not.toBeNull();
    }
    expect((await SkillShareLinkModel.findById(link.id))?.revokedAt).toEqual(
      expect.any(Date),
    );
  });

  test("lists and disconnects Amp from its OAuth sign-in alone", async ({
    makeOAuthClient,
  }) => {
    // Amp set up by hand: no setup ticket, just its DCR client and a grant.
    const amp = await makeOAuthClient({
      name: "Amp MCP Client (archestra)",
      redirectUris: ["http://localhost:41592/oauth/callback"],
    });
    // Another app that merely names itself Amp is not trusted.
    const lookalike = await makeOAuthClient({
      name: "Amp MCP Client (archestra)",
      redirectUris: ["http://localhost:1234/callback"],
    });
    const refresh = await token(user.id, amp.clientId);
    const kept = await token(user.id, lookalike.clientId);

    const listed = await ConnectedClientModel.listForUser({
      organizationId,
      userId: user.id,
    });
    expect(listed).toEqual([
      expect.objectContaining({ clientId: "amp", platform: null }),
    ]);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/connected-clients/amp",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      setups: 0,
      oauthClients: 1,
      tokens: 2,
      shareLinks: 0,
    });
    expect(await OAuthRefreshTokenModel.getById(refresh.id)).toBeNull();
    expect(await OAuthRefreshTokenModel.getById(kept.id)).not.toBeNull();
    expect(
      await ConnectedClientModel.listForUser({
        organizationId,
        userId: user.id,
      }),
    ).toEqual([]);
  });

  test("returns 404 for a client the caller has not connected", async () => {
    await redeem(user.id, "claude-code");
    await app.inject({
      method: "DELETE",
      url: "/api/connected-clients/claude-code",
    });

    const again = await app.inject({
      method: "DELETE",
      url: "/api/connected-clients/claude-code",
    });
    const never = await app.inject({
      method: "DELETE",
      url: "/api/connected-clients/codex",
    });
    const noAmp = await app.inject({
      method: "DELETE",
      url: "/api/connected-clients/amp",
    });

    expect(again.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
    expect(noAmp.statusCode).toBe(404);
  });

  async function redeem(userId: string, clientId: "claude-code" | "codex") {
    const { setup, rawToken } = await ConnectionSetupModel.create({
      organizationId,
      userId,
      clientId,
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken });
    return setup.id;
  }

  /** A refresh token plus the access token minted from it. */
  async function token(userId: string, clientId: string) {
    const refresh = await OAuthRefreshTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId,
      userId,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await OAuthAccessTokenModel.create({
      tokenHash: crypto.randomUUID(),
      clientId,
      userId,
      scopes: ["mcp"],
      expiresAt: new Date(Date.now() + 60_000),
      refreshId: refresh.id,
    });
    return refresh;
  }
});
