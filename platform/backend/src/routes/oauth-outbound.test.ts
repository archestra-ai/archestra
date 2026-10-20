import { lookup } from "node:dns/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import EnvironmentModel from "@/models/environment";
import { secretManager } from "@/secrets-manager";
import {
  createMcpOAuthFetch,
  McpOAuthOutboundError,
} from "@/services/mcp-oauth-fetch";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import oauthRoutes, {
  discoverOAuthEndpoints,
  refreshOAuthToken,
} from "./oauth";
import { OAUTH_CALLBACK_PATH } from "./route-paths";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const servers: Server[] = [];
describe("outbound OAuth integration", () => {
  setupTestCacheManager();
  const ctx = useRouteTestApp(oauthRoutes);
  beforeEach(() => {
    config.mcpOAuth.enforceOutboundValidation = true;
    config.production = false;
    config.test.enableE2eTestEndpoints = false;
    vi.mocked(lookup).mockReset();
    vi.mocked(lookup).mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
    ] as never);
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("global catalog callback uses initiating organization from state without an authenticated callback request", async ({
    makeInternalMcpCatalog,
  }) => {
    const base = await serve((req, res) => {
      if (req.url === "/token")
        res.end(
          JSON.stringify({
            access_token: "global-token",
            token_type: "Bearer",
          }),
        );
      else res.end(JSON.stringify(metadata(base)));
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: null,
      oauthConfig: { ...oauth(base), supports_resource_metadata: false },
    });
    const initiated = await ctx.app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: { catalogId: catalog.id },
    });
    expect(initiated.statusCode, initiated.body).toBe(200);
    const callbackApp = createFastifyInstance();
    await callbackApp.register(oauthRoutes);
    try {
      const callback = await callbackApp.inject({
        method: "POST",
        url: OAUTH_CALLBACK_PATH,
        payload: { state: initiated.json().state, code: "synthetic-code" },
      });
      expect(callback.statusCode, callback.body).toBe(200);
      expect(
        (await secretManager().getSecret(callback.json().secretId))?.secret
          .access_token,
      ).toBe("global-token");
    } finally {
      await callbackApp.close();
    }
  });

  test("resource metadata to authorization metadata to token chain persists credentials and refresh preserves them", async ({
    makeInternalMcpCatalog,
  }) => {
    const bodies: string[] = [];
    const paths: string[] = [];
    const base = await serve(async (req, res) => {
      paths.push(req.url ?? "");
      if (req.url?.includes("oauth-protected-resource")) {
        res.end(
          JSON.stringify({
            authorization_servers: [base],
            scopes_supported: ["read"],
          }),
        );
        return;
      }
      if (req.url?.includes(".well-known")) {
        res.end(JSON.stringify(metadata(base)));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push(body);
      res.end(
        JSON.stringify({
          access_token: bodies.length === 1 ? "first-token" : "refreshed-token",
          ...(bodies.length === 1 ? { refresh_token: "keep-refresh" } : {}),
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      serverType: "remote",
      serverUrl: `${base}/mcp`,
      oauthConfig: oauth(base),
    });
    const initiated = await ctx.app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: { catalogId: catalog.id },
    });
    expect(initiated.statusCode, initiated.body).toBe(200);
    const callback = await ctx.app.inject({
      method: "POST",
      url: OAUTH_CALLBACK_PATH,
      payload: { state: initiated.json().state, code: "synthetic-code" },
    });
    expect(callback.statusCode, callback.body).toBe(200);
    const secretId = callback.json().secretId;
    expect((await secretManager().getSecret(secretId))?.secret).toMatchObject({
      access_token: "first-token",
      refresh_token: "keep-refresh",
      client_id: "synthetic-client",
      client_secret: "synthetic-secret",
    });
    expect(
      await refreshOAuthToken({ secretId: secretId, catalogId: catalog.id }),
    ).toEqual({ ok: true });
    expect((await secretManager().getSecret(secretId))?.secret).toMatchObject({
      access_token: "refreshed-token",
      refresh_token: "keep-refresh",
      client_secret: "synthetic-secret",
    });
    expect(
      paths.some((path) => path.includes("oauth-protected-resource")),
    ).toBe(true);
    expect(
      paths.some((path) => path.includes("oauth-authorization-server")),
    ).toBe(true);
    expect(new URLSearchParams(bodies[0]).get("code")).toBe("synthetic-code");
    expect(new URLSearchParams(bodies[1]).get("refresh_token")).toBe(
      "keep-refresh",
    );
  });

  test.for([
    "resource",
    "auth_override",
    "metadata_override",
    "token_override",
  ])("blocks denied %s without callback/refresh fallback or secret mutation", async (variant, {
    makeInternalMcpCatalog,
  }) => {
    let canary = 0;
    const base = await serve((req, res) => {
      if (req.url === "/canary") {
        canary++;
        res.end('{"access_token":"bad"}');
        return;
      }
      const host = base.replace("127.0.0.1", "denied.example");
      if (req.url?.includes("oauth-protected-resource"))
        res.end(JSON.stringify({ authorization_servers: [`${host}/canary`] }));
      else res.end(JSON.stringify(metadata(base)));
    });
    const env = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "restricted",
      networkPolicy: {
        egressMode: "restricted",
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: ["127.0.0.0/8"],
      },
    });
    const denied = `${base.replace("127.0.0.1", "denied.example")}/canary`;
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      environmentId: env.id,
      serverType: "local",
      oauthConfig: {
        ...oauth(base),
        supports_resource_metadata: variant === "resource",
        ...(variant === "auth_override" ? { auth_server_url: denied } : {}),
        ...(variant === "metadata_override" ? { well_known_url: denied } : {}),
        ...(variant === "token_override" ? { token_endpoint: denied } : {}),
      },
    });
    const secret = await secretManager().createSecret(
      {
        access_token: "still-valid",
        refresh_token: "still-refresh",
        client_secret: "stored-secret",
      },
      "synthetic-oauth",
    );
    await expect(
      refreshOAuthToken({ secretId: secret.id, catalogId: catalog.id }),
    ).rejects.toBeInstanceOf(McpOAuthOutboundError);
    expect((await secretManager().getSecret(secret.id))?.secret).toMatchObject({
      access_token: "still-valid",
      refresh_token: "still-refresh",
    });
    const state = await seedState(catalog.id);
    const callback = await ctx.app.inject({
      method: "POST",
      url: OAUTH_CALLBACK_PATH,
      payload: { code: "synthetic-code", state },
    });
    expect(callback.statusCode, callback.body).toBe(400);
    expect(callback.body).not.toContain("synthetic-secret");
    expect(canary).toBe(0);
  });

  test("scope discovery security refusal escapes before registration or authorization", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      oauthConfig: { ...oauth("https://10.0.0.1"), scopes: [] },
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: { catalogId: catalog.id },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.message).toContain("outbound request refused");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("dynamic registration redirect refusal is never retried with different scopes", async ({
    makeInternalMcpCatalog,
  }) => {
    let registrations = 0;
    let canary = 0;
    const base = await serve((req, res) => {
      if (req.url === "/register") {
        registrations++;
        res.writeHead(307, { location: "/canary" }).end();
      } else if (req.url === "/canary") {
        canary++;
        res.end("bad");
      } else
        res.end(
          JSON.stringify({
            ...metadata(base),
            registration_endpoint: `${base}/register`,
          }),
        );
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      oauthConfig: { ...oauth(base), client_id: "", client_secret: undefined },
    });
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/oauth/initiate",
      payload: { catalogId: catalog.id },
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(registrations).toBe(1);
    expect(canary).toBe(0);
  });

  test.for([
    false,
    true,
  ])("SDK exchangeAuthorization fetchFn enforces redirect policy with enforcement=%s", async (enforced, {
    makeInternalMcpCatalog,
  }) => {
    config.mcpOAuth.enforceOutboundValidation = enforced;
    let canary = 0;
    let received = "";
    const base = await serve(async (req, res) => {
      if (req.url === "/token") {
        res.writeHead(307, { location: "/canary" }).end();
        return;
      }
      canary++;
      for await (const chunk of req) received += chunk;
      res.end(
        JSON.stringify({ access_token: "sdk-token", token_type: "Bearer" }),
      );
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      oauthConfig: { ...oauth(base), requires_proxy: true },
    });
    const state = await seedState(catalog.id);
    const result = await ctx.app.inject({
      method: "POST",
      url: OAUTH_CALLBACK_PATH,
      payload: { code: "synthetic-code", state },
    });
    expect(result.statusCode, result.body).toBe(enforced ? 400 : 200);
    expect(canary).toBe(enforced ? 0 : 1);
    if (!enforced)
      expect(new URLSearchParams(received).get("code")).toBe("synthetic-code");
  });

  test("ordinary metadata transport failure tries a separately guarded fallback", async ({
    makeInternalMcpCatalog,
  }) => {
    const paths: string[] = [];
    const base = await serve((req, res) => {
      paths.push(req.url ?? "");
      if (req.url === "/.well-known/oauth-authorization-server/mcp")
        req.socket.destroy();
      else res.end(JSON.stringify(metadata(`${base}/mcp`)));
    });
    const catalog = await makeInternalMcpCatalog();
    const endpoints = await discoverOAuthEndpoints(
      { ...oauth(`${base}/mcp`), supports_resource_metadata: false },
      { fetchFn: createMcpOAuthFetch({ catalog }) },
    );
    expect(endpoints.tokenEndpoint).toBe(`${base}/mcp/token`);
    expect(paths).toEqual([
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/oauth-authorization-server",
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("ordinary token transport failure remains transient and retains valid stored tokens", async ({
    makeInternalMcpCatalog,
  }) => {
    const base = await serve((req, res) => {
      if (req.url === "/token") req.socket.destroy();
      else res.end(JSON.stringify(metadata(base)));
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      oauthConfig: oauth(base),
    });
    const secret = await secretManager().createSecret(
      { access_token: "keep-token", refresh_token: "keep-refresh" },
      "synthetic-oauth",
    );
    expect(
      await refreshOAuthToken({ secretId: secret.id, catalogId: catalog.id }),
    ).toEqual({
      ok: false,
      kind: "transient",
      reason: "network",
    });
    expect((await secretManager().getSecret(secret.id))?.secret).toMatchObject({
      access_token: "keep-token",
      refresh_token: "keep-refresh",
    });
  });

  test("default compatibility preserves production HTTP refresh redirects and provider-specific fields", async ({
    makeInternalMcpCatalog,
  }) => {
    config.mcpOAuth.enforceOutboundValidation = false;
    config.production = true;
    let body = "";
    const base = await serve(async (req, res) => {
      if (req.url === "/token") {
        res.writeHead(307, { location: "/refresh" }).end();
        return;
      }
      if (req.url === "/refresh") {
        for await (const chunk of req) body += chunk;
        res.end('{"access_token":"renewed","scope":"read"}');
        return;
      }
      res.end(JSON.stringify(metadata(base)));
    });
    const catalog = await makeInternalMcpCatalog({ oauthConfig: oauth(base) });
    const secret = await secretManager().createSecret(
      {
        access_token: "old-token",
        refresh_token: "keep-refresh",
        client_secret: "keep-client-secret",
        custom_field: "keep-me",
      },
      "synthetic-oauth",
    );
    expect(
      await refreshOAuthToken({ secretId: secret.id, catalogId: catalog.id }),
    ).toEqual({
      ok: true,
    });
    expect(new URLSearchParams(body).get("refresh_token")).toBe("keep-refresh");
    expect((await secretManager().getSecret(secret.id))?.secret).toMatchObject({
      access_token: "renewed",
      refresh_token: "keep-refresh",
      custom_field: "keep-me",
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

function oauth(base: string) {
  return {
    name: "Synthetic OAuth",
    server_url: base,
    grant_type: "authorization_code" as const,
    client_id: "synthetic-client",
    client_secret: "synthetic-secret",
    redirect_uris: ["http://localhost:3000/oauth-callback"],
    scopes: ["read"],
    default_scopes: ["read"],
    supports_resource_metadata: true,
  };
}
function metadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
  };
}
async function seedState(catalogId: string): Promise<string> {
  const state = crypto.randomUUID();
  await cacheManager.set(
    `${CacheKey.OAuthState}-${state}`,
    {
      catalogId,
      codeVerifier: "synthetic-verifier",
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
    },
    600_000,
  );
  return state;
}
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
