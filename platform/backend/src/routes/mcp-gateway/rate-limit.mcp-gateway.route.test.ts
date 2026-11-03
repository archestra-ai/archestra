import { createHash, randomUUID } from "node:crypto";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import OAuthAccessTokenModel from "@/models/oauth-access-token";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import { withMcpGatewayAuthenticationCapacity } from "@/services/mcp-gateway-rate-limit";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import mcpGatewayRoutes from "./index";

setupTestCacheManager();

describe("MCP Gateway authentication rate limiting", () => {
  let app: ReturnType<typeof createFastifyInstance>;
  beforeEach(async () => {
    config.api.trustProxy = false;
    config.authRateLimitDisabled = false;
    app = createFastifyInstance();
    await app.register(mcpGatewayRoutes);
  });
  afterEach(async () => app.close());

  test("keeps tokenless OAuth discovery available on a noisy IP", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({ organizationId: org.id });
    const url = `/v1/mcp/${gateway.id}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: { authorization: `Bearer ${randomUUID()}` },
          })
        ).statusCode,
      ).toBe(401);
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
      expect(response.headers["retry-after"]).toBeUndefined();
    }
  });

  test("honors the auth rate-limit disable setting without bypassing authentication", async ({
    makeOrganization,
    makeAgent,
  }) => {
    config.authRateLimitDisabled = true;
    const org = await makeOrganization();
    const gateway = await makeAgent({ organizationId: org.id });
    const authorization = `Bearer ${randomUUID()}`;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/mcp/${gateway.id}`,
        headers: { authorization },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    }
  });

  test("shares the failed-credential budget across transports and returns Retry-After without OAuth discovery", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({ organizationId: org.id });
    const credential = `invalid-${randomUUID()}`;
    const transports = ["POST", "GET", "DELETE", "messages"] as const;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const transport = transports[attempt % transports.length];
      const response = await app.inject({
        method: transport === "messages" ? "POST" : transport,
        url: `/v1/mcp/${gateway.id}${transport === "messages" ? `/${transport}?sessionId=${randomUUID()}` : ""}`,
        headers: {
          authorization: `${attempt % 2 ? "bEaReR    " : "Bearer "}${credential}`,
          accept: "application/json, text/event-stream",
        },
        ...(transport === "POST" || transport === "messages"
          ? { payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } }
          : {}),
      });
      expect(response.statusCode, `attempt ${attempt + 1}`).toBe(
        attempt < 10 ? 401 : 429,
      );
      if (attempt >= 10) {
        expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
        expect(Number(response.headers["retry-after"])).toBeLessThanOrEqual(60);
        expect(response.headers["www-authenticate"]).toBeUndefined();
      }
    }
  });
  test("admits new and idle clients on a noisy IP across replicas and rechecks revocation", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const owner = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const gateway = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "mcp_gateway",
      access: { users: [user.id] },
    });
    const client = await makeOAuthClient({ userId: user.id });
    const token = randomUUID();
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: createHash("sha256").update(token).digest("base64url"),
      referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${gateway.id}`,
    });
    const request = {
      method: "GET" as const,
      url: `/v1/mcp/${gateway.id}`,
      headers: { authorization: `Bearer ${token}` },
    };
    const replica = createFastifyInstance();
    await replica.register(mcpGatewayRoutes);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      // Authenticated GET with no legacy-SSE Accept header normally returns 405.
      expect((await app.inject(request)).statusCode).toBe(405);
      expect((await replica.inject(request)).statusCode).toBe(405);
      // Expire the original exemption before an unrelated caller rotates guesses.
      clock.mockReturnValue(now + 61_000);
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const rejected = await app.inject({
          ...request,
          headers: {
            authorization: `Bearer ${randomUUID()}`,
            // These untrusted headers do not create independent origins.
            "x-forwarded-for": `192.0.2.${attempt + 1}`,
          },
        });
        expect(rejected.statusCode).toBe(401);
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        expect((await replica.inject(request)).statusCode).toBe(405);
      }
      const newToken = randomUUID();
      const hash = createHash("sha256").update(newToken).digest("base64url");
      await makeOAuthAccessToken(client.clientId, user.id, {
        token: hash,
        referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${gateway.id}`,
      });
      const freshRequest = {
        ...request,
        headers: { authorization: `Bearer ${newToken}` },
      };
      for (const instance of [app, replica])
        expect((await instance.inject(freshRequest)).statusCode).toBe(405);
      await OAuthAccessTokenModel.deleteByTokenHash(hash);
      for (const instance of [app, replica]) {
        const revoked = await instance.inject(freshRequest);
        expect(revoked.statusCode).toBe(401);
        expect(revoked.headers["www-authenticate"]).toContain(
          "resource_metadata",
        );
      }
      const key = {
        organizationId: org.id,
        resource: "mcpGateway" as const,
        scope: gateway.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(key);
      if (!policy) throw new Error("Expected gateway policy");
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy.revision,
        grants: [],
      });
      for (const instance of [app, replica]) {
        const denied = await instance.inject(request);
        expect(denied.statusCode).toBe(403);
        expect(denied.headers["www-authenticate"]).toBeUndefined();
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const denied = await replica.inject(request);
        expect([403, 429]).toContain(denied.statusCode);
      }
      expect((await app.inject(request)).statusCode).toBe(429);
    } finally {
      clock.mockRestore();
      await replica.close();
    }
  });

  test("keeps established OAuth and platform clients working while unknown callers fill capacity", async ({
    makeOrganization,
    makeAgent,
    makeUser,
    makeMember,
    makeOAuthClient,
    makeOAuthAccessToken,
    makeServiceAccountToken,
  }) => {
    const org = await makeOrganization();
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const client = await makeOAuthClient({ userId: user.id });
    const token = randomUUID();
    const hash = createHash("sha256").update(token).digest("base64url");
    await makeOAuthAccessToken(client.clientId, user.id, {
      token: hash,
      referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${gateway.id}`,
    });
    const platformToken = await makeServiceAccountToken({
      organizationId: org.id,
    });
    const replica = createFastifyInstance();
    await replica.register(mcpGatewayRoutes);
    const request = {
      method: "GET" as const,
      url: `/v1/mcp/${gateway.id}`,
      headers: { authorization: `Bearer ${randomUUID()}` },
    };
    const established = [token, platformToken.value].map((credential) => ({
      ...request,
      headers: { authorization: `Bearer ${credential}` },
    }));
    let release = () => {};
    let pending: Promise<void>[] = [];
    try {
      for (const instance of [app, replica])
        for (const authenticated of established)
          expect((await instance.inject(authenticated)).statusCode).toBe(405);
      const pendingWork = new Promise<void>((resolve) => {
        release = resolve;
      });
      pending = Array.from({ length: 16 }, () =>
        withMcpGatewayAuthenticationCapacity(() => pendingWork),
      );
      for (const instance of [app, replica]) {
        const busy = await instance.inject(request);
        expect(busy.statusCode).toBe(503);
        expect(busy.headers["retry-after"]).toBe("1");
        expect(busy.headers["www-authenticate"]).toBeUndefined();
        for (const authenticated of established)
          expect((await instance.inject(authenticated)).statusCode).toBe(405);
        const discovery = await instance.inject({
          method: "GET",
          url: request.url,
        });
        expect(discovery.statusCode).toBe(401);
        expect(discovery.headers["www-authenticate"]).toContain(
          "resource_metadata",
        );
      }
      await OAuthAccessTokenModel.deleteByTokenHash(hash);
      for (const instance of [app, replica]) {
        const revoked = await instance.inject(established[0]);
        expect(revoked.statusCode).toBe(401);
        expect(revoked.headers["www-authenticate"]).toContain(
          "resource_metadata",
        );
        // A denied client loses priority and returns to unknown-caller capacity.
        expect((await instance.inject(established[0])).statusCode).toBe(503);
      }
      config.authRateLimitDisabled = true;
      expect((await app.inject(request)).statusCode).toBe(401);
      config.authRateLimitDisabled = false;
    } finally {
      release();
      await Promise.all(pending);
      await replica.close();
    }
    expect((await app.inject(request)).statusCode).toBe(401);
  });

  test("returns 503 before authentication when the budget cannot be read", async () => {
    cacheManager.shutdown();
    const response = await app.inject({
      method: "GET",
      url: `/v1/mcp/${randomUUID()}`,
      headers: { authorization: `Bearer ${randomUUID()}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["www-authenticate"]).toBeUndefined();
  });
});
