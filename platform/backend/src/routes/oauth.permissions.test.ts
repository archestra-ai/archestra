// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createHash } from "node:crypto";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { CacheKey, cacheManager } from "@/cache-manager";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { InternalMcpCatalog, User } from "@/types";
import oauthRoutes from "./oauth";

describe("MCP installation OAuth authorization", () => {
  setupTestCacheManager();
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;
  let owner: User;
  let catalog: InternalMcpCatalog;
  let challenge: string;
  let expectedClientSecret: string;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      organizationId = (await makeOrganization()).id;
      caller = await makeUser();
      owner = await makeUser();
      await makeMember(caller.id, organizationId);
      await makeMember(owner.id, organizationId);
      catalog = await makeInternalMcpCatalog({
        organizationId,
        authorId: owner.id,
        scope: "personal",
        name: "Private OAuth server",
        oauthConfig: {
          name: "Private OAuth server",
          server_url: "https://mcp.example.com/mcp",
          auth_server_url: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          grant_type: "authorization_code",
          client_id: "synthetic-client",
          client_secret: "synthetic-secret",
          redirect_uris: ["http://localhost:3000/oauth-callback"],
          scopes: ["read"],
          default_scopes: ["read"],
          supports_resource_metadata: false,
        },
      });
      app = await authenticatedRouteApp({
        organizationId,
        routes: [oauthRoutes],
      });
      challenge = "";
      expectedClientSecret = "synthetic-secret";
      fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        if (String(input) === "https://auth.example.com/token") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("synthetic-client");
          expect(body.get("client_secret")).toBe(expectedClientSecret);
          expect(body.get("redirect_uri")).toBe(
            "http://localhost:3000/oauth-callback",
          );
          expect(
            createHash("sha256")
              .update(body.get("code_verifier") ?? "")
              .digest("base64url"),
          ).toBe(challenge);
          return Response.json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
          });
        }
        return Response.json({
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          scopes_supported: ["read"],
        });
      });
      vi.stubGlobal("fetch", fetchMock);
    },
  );

  afterEach(async () => {
    await app.close();
    vi.mocked(betterAuth.api.getSession).mockRestore();
  });

  async function grant(actions: string[]) {
    await InternalMcpCatalogModel.update(catalog.id, {
      scope: actions.includes("use") ? "org" : "personal",
    });
  }

  function initiate(userId = caller.id, serverId?: string) {
    return app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      headers: { [USER_HEADER]: userId },
      payload: { catalogId: catalog.id, ...(serverId && { serverId }) },
    });
  }

  function callback(state: string, userId = caller.id) {
    return app.inject({
      method: "POST",
      url: "/api/oauth/callback",
      headers: { [USER_HEADER]: userId },
      payload: { code: "synthetic-code", state },
    });
  }

  async function start(userId = caller.id) {
    const response = await initiate(userId);
    expect(response.statusCode, response.body).toBe(200);
    challenge =
      new URL(response.json().authorizationUrl).searchParams.get(
        "code_challenge",
      ) ?? "";
    return response.json().state as string;
  }

  test("the owner can authorize their own private catalog", async () => {
    const state = await start(owner.id);
    expect((await callback(state, owner.id)).statusCode).toBe(200);
  });

  for (const audience of ["organization", "team"] as const) {
    test(`honors ${audience} catalog access`, async ({
      makeInternalMcpCatalog,
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, owner.id);
      catalog = await makeInternalMcpCatalog({
        organizationId,
        authorId: owner.id,
        oauthConfig: catalog.oauthConfig,
        scope: audience === "organization" ? "org" : "team",
        ...(audience === "team" ? { teams: [team.id] } : {}),
      });
      if (audience === "team") {
        expect((await initiate()).statusCode).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
        await makeTeamMember(team.id, caller.id);
      }
      const state = await start();
      expect((await callback(state)).statusCode).toBe(200);
    });
  }

  for (const [access, actions, expected] of [["private", [], 404]] as const) {
    test(`rejects ${access} before resolving secrets or contacting the provider`, async () => {
      await grant([...actions]);
      const readSecret = vi.spyOn(secretManager(), "getSecret");
      const cacheWrite = vi.spyOn(cacheManager, "set");
      try {
        const response = await initiate();
        expect(response.statusCode, response.body).toBe(expected);
        expect(readSecret).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(
          cacheWrite.mock.calls.filter(([key]) =>
            key.startsWith(`${CacheKey.OAuthState}-`),
          ),
        ).toHaveLength(0);
      } finally {
        readSecret.mockRestore();
        cacheWrite.mockRestore();
      }
    });
  }

  test("allows Use, resolves only the OAuth secret, and consumes state once", async ({
    makeSecret,
  }) => {
    await grant(["read", "use"]);
    const unrelated = await makeSecret({
      secret: { LOCAL_KEY: "unrelated-local-secret" },
    });
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfigSecretId: unrelated.id,
      localConfig: {
        environment: [
          { key: "LOCAL_KEY", type: "secret", promptOnInstallation: false },
        ],
      },
    });
    const readSecret = vi.spyOn(secretManager(), "getSecret");
    try {
      const state = await start();
      const response = await callback(state);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().accessToken).toBe("synthetic-access");
      expect(readSecret.mock.calls.some(([id]) => id === unrelated.id)).toBe(
        false,
      );
      expect((await callback(state)).statusCode).toBe(400);
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === "https://auth.example.com/token",
        ),
      ).toHaveLength(1);
    } finally {
      readSecret.mockRestore();
    }
  });

  test("another user cannot consume the initiator's state", async () => {
    await grant(["read", "use"]);
    const state = await start();
    fetchMock.mockClear();
    expect((await callback(state, owner.id)).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await callback(state)).statusCode).toBe(200);
  });

  test("requires authentication even when a callback supplies a valid state", async () => {
    await grant(["read", "use"]);
    const state = await start();
    fetchMock.mockClear();
    const response = await app.inject({
      method: "POST",
      url: "/api/oauth/callback",
      payload: { code: "synthetic-code", state },
    });
    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await callback(state)).statusCode).toBe(200);
  });

  test("another session of the same user cannot consume the state", async () => {
    await grant(["read", "use"]);
    const state = await start();
    const lookup = vi.mocked(betterAuth.api.getSession);
    const original = lookup.getMockImplementation();
    if (!original) throw new Error("Session lookup is not configured");
    lookup.mockImplementation((async () => ({
      response: {
        user: { id: caller.id },
        session: {
          id: "different-session",
          createdAt: new Date(),
          activeOrganizationId: organizationId,
        },
      },
      headers: new Headers(),
    })) as unknown as typeof betterAuth.api.getSession);
    fetchMock.mockClear();
    expect((await callback(state)).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    lookup.mockImplementation(original);
    expect((await callback(state)).statusCode).toBe(200);
  });

  test("supports API-key initiation and completion without a browser session", async () => {
    await grant(["read", "use"]);
    const verify = vi.spyOn(betterAuth.api, "verifyApiKey").mockResolvedValue({
      valid: true,
      key: { referenceId: caller.id },
    } as Awaited<ReturnType<typeof betterAuth.api.verifyApiKey>>);
    const headers = { authorization: "synthetic-api-key" };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/oauth/initiate",
        headers,
        payload: { catalogId: catalog.id },
      });
      expect(response.statusCode, response.body).toBe(200);
      challenge =
        new URL(response.json().authorizationUrl).searchParams.get(
          "code_challenge",
        ) ?? "";
      const completed = await app.inject({
        method: "POST",
        url: "/api/oauth/callback",
        headers,
        payload: { code: "synthetic-code", state: response.json().state },
      });
      expect(completed.statusCode, completed.body).toBe(200);
    } finally {
      verify.mockRestore();
    }
  });

  test("uses the current configured client secret after credential rotation", async ({
    makeSecret,
  }) => {
    await grant(["read", "use"]);
    if (!catalog.oauthConfig)
      throw new Error("OAuth fixture is not configured");
    const secret = await makeSecret({
      secret: { client_secret: expectedClientSecret },
    });
    await InternalMcpCatalogModel.update(catalog.id, {
      clientSecretId: secret.id,
      oauthConfig: { ...catalog.oauthConfig, client_secret: "" },
    });
    const state = await start();
    expectedClientSecret = "rotated-synthetic-secret";
    await SecretModel.update(secret.id, {
      secret: { client_secret: expectedClientSecret },
    });
    expect((await callback(state)).statusCode).toBe(200);
  });

  test("concurrent callbacks exchange the authorization code only once", async () => {
    await grant(["read", "use"]);
    const state = await start();
    fetchMock.mockClear();
    const responses = await Promise.all([callback(state), callback(state)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 400,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("expired state cannot be exchanged", async () => {
    await grant(["read", "use"]);
    const state = await start();
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    fetchMock.mockClear();
    try {
      expect((await callback(state)).statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  test("checks access again if access is revoked during provider authorization", async () => {
    await grant(["read", "use"]);
    const state = await start();
    await grant(["read"]);
    fetchMock.mockClear();
    const response = await callback(state);
    expect(response.statusCode, response.body).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects configuration changes before exchanging the code", async () => {
    await grant(["read", "use"]);
    const state = await start();
    if (!catalog.oauthConfig)
      throw new Error("OAuth fixture is not configured");
    await InternalMcpCatalogModel.update(catalog.id, {
      oauthConfig: {
        ...catalog.oauthConfig,
        token_endpoint: "https://changed.example.com/token",
      },
    });
    fetchMock.mockClear();
    expect((await callback(state)).statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects legacy unbound state without token exchange", async () => {
    await cacheManager.set(`${CacheKey.OAuthState}-legacy`, {
      catalogId: catalog.id,
      codeVerifier: "legacy-verifier",
    });
    expect((await callback("legacy")).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a deleted catalog cannot complete an existing authorization", async () => {
    await grant(["read", "use"]);
    const state = await start();
    await InternalMcpCatalogModel.delete(catalog.id);
    fetchMock.mockClear();
    expect((await callback(state)).statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("authorizes the reauthentication target before any provider request", async ({
    makeMcpServer,
  }) => {
    await grant(["read", "use"]);
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: owner.id,
      scope: "personal",
    });
    expect((await initiate(caller.id, server.id)).statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rechecks connection ownership when reauthentication completes", async ({
    makeMcpServer,
  }) => {
    await grant(["read", "use"]);
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: caller.id,
      scope: "personal",
    });
    const response = await initiate(caller.id, server.id);
    expect(response.statusCode, response.body).toBe(200);
    await McpServerModel.update(server.id, { ownerId: owner.id });
    fetchMock.mockClear();
    expect((await callback(response.json().state)).statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
