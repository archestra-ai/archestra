import formbody from "@fastify/formbody";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import OAuthRefreshTokenModel from "@/models/oauth-refresh-token";
import authRoutes from "@/routes/auth";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";

setupTestCacheManager();

describe("managed OAuth access-token revocation", () => {
  let app: FastifyInstanceWithZod;
  beforeEach(async () => {
    config.authRateLimitDisabled = true;
    app = createFastifyInstance();
    await app.register(formbody);
    await app.register(authRoutes);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const post = (
    path: string,
    body: Record<string, string>,
    authorization?: string,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/auth/oauth2/${path}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(authorization ? { authorization } : {}),
      },
      payload: new URLSearchParams(body).toString(),
    });

  test("shares the trusted-IP token budget and throttles before password verification without deleting tokens", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const appClient = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: user.id,
      name: "Limited app",
      scopes: ["a2a"],
    });
    const credentials = {
      client_id: appClient.oauthClient.clientId,
      client_secret: appClient.clientSecret,
    };
    const issued = await post("token", {
      ...credentials,
      grant_type: "client_credentials",
    });
    expect(issued.statusCode).toBe(200);
    const token = issued.json().access_token;
    config.authRateLimitDisabled = false;
    for (let i = 0; i < 100; i++)
      expect(
        (
          await post("token", {
            client_id: "unknown",
            client_secret: "wrong",
            grant_type: "client_credentials",
          })
        ).statusCode,
      ).toBe(401);
    const verify = vi.spyOn(
      ManagedOauthClientModel,
      "findClientForCredentials",
    );
    const blocked = await post("revoke", { ...credentials, token });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(verify).not.toHaveBeenCalled();
    expect(
      await OAuthAccessTokenModel.getByTokenHash(
        OAuthAccessTokenModel.hashTokenForLookup(token),
      ),
    ).toBeDefined();
  });

  test("rejects bad credentials and malformed requests without deleting tokens; foreign tokens are a no-op", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const create = (name: string) =>
      ManagedOauthClientModel.create({
        organizationId: org.id,
        authorId: user.id,
        name,
        scopes: ["a2a"],
      });
    const first = await create("First synthetic app");
    const other = await create("Other synthetic app");
    const credentials = {
      client_id: first.oauthClient.clientId,
      client_secret: first.clientSecret,
    };
    const issued = await post("token", {
      ...credentials,
      grant_type: "client_credentials",
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const token = issued.json().access_token;
    const hash = OAuthAccessTokenModel.hashTokenForLookup(token);
    for (const badCredentials of [
      { client_id: credentials.client_id, client_secret: "wrong" },
      { client_id: credentials.client_id, client_secret: "" },
      { client_id: "deleted-client", client_secret: first.clientSecret },
    ]) {
      expect(
        (await post("revoke", { ...badCredentials, token })).statusCode,
      ).toBe(badCredentials.client_id === "deleted-client" ? 400 : 401);
      expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeDefined();
    }
    expect(
      (
        await post("revoke", {
          client_id: other.oauthClient.clientId,
          client_secret: other.clientSecret,
          token,
        })
      ).statusCode,
    ).toBe(200);
    expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeDefined();
    for (const body of [
      { ...credentials },
      { ...credentials, token: "" },
      { ...credentials, token, token_type_hint: "invalid" },
    ]) {
      expect((await post("revoke", body)).statusCode).toBe(400);
      expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeDefined();
    }
    // A hint cannot prevent locating the actual access token.
    expect(
      (
        await post("revoke", {
          ...credentials,
          token,
          token_type_hint: "refresh_token",
        })
      ).statusCode,
    ).toBe(200);
    expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeUndefined();
  });

  test("rejects disabled clients and rotated secrets while accepting the current secret", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const appClient = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: user.id,
      name: "Rotated app",
      scopes: ["a2a"],
    });
    const credentials = {
      client_id: appClient.oauthClient.clientId,
      client_secret: appClient.clientSecret,
    };
    const issued = await post("token", {
      ...credentials,
      grant_type: "client_credentials",
    });
    expect(issued.statusCode).toBe(200);
    const token = issued.json().access_token;
    const hash = OAuthAccessTokenModel.hashTokenForLookup(token);
    await db
      .update(schema.oauthClientsTable)
      .set({ disabled: true })
      .where(eq(schema.oauthClientsTable.clientId, credentials.client_id));
    expect((await post("revoke", { ...credentials, token })).statusCode).toBe(
      401,
    );
    expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeDefined();
    await db
      .update(schema.oauthClientsTable)
      .set({ disabled: false })
      .where(eq(schema.oauthClientsTable.clientId, credentials.client_id));
    const rotated = await ManagedOauthClientModel.rotateSecret({
      id: appClient.oauthClient.id,
      organizationId: org.id,
    });
    expect(rotated).toBeDefined();
    expect((await post("revoke", { ...credentials, token })).statusCode).toBe(
      401,
    );
    expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeDefined();
    expect(
      (
        await post("revoke", {
          ...credentials,
          client_secret: rotated?.clientSecret ?? "",
          token,
        })
      ).statusCode,
    ).toBe(200);
    expect(await OAuthAccessTokenModel.getByTokenHash(hash)).toBeUndefined();
  });

  for (const kind of ["public", "authorization_code"] as const) {
    test(`preserves ${kind} user-token revocation and refresh replay shielding`, async ({
      makeOrganization,
      makeUser,
      makeOAuthClient,
      makeOAuthAccessToken,
      makeOAuthRefreshToken,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const managed =
        kind === "authorization_code"
          ? await ManagedOauthClientModel.create({
              organizationId: org.id,
              authorId: user.id,
              name: "User OAuth app",
              grantType: "authorization_code",
              scopes: ["mcp"],
              redirectUris: ["http://localhost/callback"],
            })
          : null;
      const client = managed?.oauthClient ?? (await makeOAuthClient());
      const credentials = {
        client_id: client.clientId,
        ...(managed ? { client_secret: managed.clientSecret } : {}),
      };
      const token = crypto.randomUUID();
      const other = crypto.randomUUID();
      const hash = OAuthAccessTokenModel.hashTokenForLookup;
      await makeOAuthAccessToken(client.clientId, user.id, {
        token: hash(token),
      });
      await makeOAuthAccessToken(client.clientId, user.id, {
        token: hash(other),
      });
      const response = await post("revoke", {
        ...credentials,
        token,
        token_type_hint: "access_token",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        await OAuthAccessTokenModel.getByTokenHash(hash(token)),
      ).toBeUndefined();
      expect(
        await OAuthAccessTokenModel.getByTokenHash(hash(other)),
      ).toBeDefined();
      const activeRefresh = crypto.randomUUID();
      await makeOAuthRefreshToken(client.clientId, user.id, {
        token: hash(activeRefresh),
      });
      const activeResponse = await post("revoke", {
        ...credentials,
        token: activeRefresh,
        token_type_hint: "refresh_token",
      });
      expect(activeResponse.statusCode, activeResponse.body).toBe(200);
      expect(
        (await OAuthRefreshTokenModel.getByTokenHash(hash(activeRefresh)))
          ?.revoked,
      ).toBeTruthy();
      expect(
        await OAuthAccessTokenModel.getByTokenHash(hash(other)),
      ).toBeDefined();
      const refresh = crypto.randomUUID();
      await makeOAuthRefreshToken(client.clientId, user.id, {
        token: hash(refresh),
        revoked: new Date(),
      });
      expect(
        (
          await post("revoke", {
            ...credentials,
            token: refresh,
            token_type_hint: "refresh_token",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await post("revoke", { ...credentials, token: "unknown-token" }))
          .statusCode,
      ).toBe(200);
      expect(
        await OAuthAccessTokenModel.getByTokenHash(hash(other)),
      ).toBeDefined();
    });
  }

  for (const legacyKind of [undefined, "mcp", "llm"] as const) {
    for (const auth of ["post", "basic"] as const) {
      test(`revokes only the selected ${legacyKind ?? "application"} token with ${auth} authentication`, async ({
        makeOrganization,
        makeUser,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const { oauthClient, clientSecret } =
          await ManagedOauthClientModel.create({
            organizationId: org.id,
            authorId: user.id,
            name: "Synthetic app",
            scopes: ["a2a"],
            legacyKind,
          });
        const credentials = {
          client_id: oauthClient.clientId,
          client_secret: clientSecret,
        };
        const mint = () =>
          post("token", {
            ...credentials,
            grant_type: "client_credentials",
            scope: "a2a",
          });
        const issued = await mint();
        expect(issued.statusCode, issued.body).toBe(200);
        const bearer = issued.json().access_token;
        const second = (await mint()).json().access_token;
        const lookup = (token: string) =>
          OAuthAccessTokenModel.getByTokenHash(
            OAuthAccessTokenModel.hashTokenForLookup(token),
          );
        expect(await lookup(bearer)).toBeDefined();
        const revoke = (token: string) =>
          post(
            "revoke",
            {
              token,
              token_type_hint: "access_token",
              ...(auth === "post" ? credentials : {}),
            },
            auth === "basic"
              ? `Basic ${Buffer.from(`${oauthClient.clientId}:${clientSecret}`).toString("base64")}`
              : undefined,
          );
        const response = await revoke(bearer);
        expect(response.statusCode, response.body).toBe(200);
        expect(await lookup(bearer)).toBeUndefined();
        expect(await lookup(second)).toBeDefined();
        expect((await revoke(bearer)).statusCode).toBe(200);
        expect(await lookup(second)).toBeDefined();
      });
    }
  }
});
