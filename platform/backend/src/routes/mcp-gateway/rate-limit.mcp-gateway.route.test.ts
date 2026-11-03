import { createHash, randomUUID } from "node:crypto";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
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

  test("keeps tokenless OAuth discovery available after the IP budget is exhausted", async ({
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
          authorization: `Bearer ${credential}`,
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
  test("keeps working clients on a noisy IP usable across replicas and rechecks revoked grants", async ({
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
    try {
      // Authenticated GET with no legacy-SSE Accept header normally returns 405.
      expect((await app.inject(request)).statusCode).toBe(405);
      expect((await replica.inject(request)).statusCode).toBe(405);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rejected = await app.inject({
          ...request,
          headers: {
            authorization: `Bearer ${randomUUID()}`,
            // Untrusted forwarding headers must not split the IP budget.
            "x-forwarded-for": `192.0.2.${attempt + 1}`,
          },
        });
        expect(rejected.statusCode).toBe(attempt < 99 ? 401 : 429);
      }
      for (let attempt = 0; attempt < 12; attempt += 1) {
        expect((await replica.inject(request)).statusCode).toBe(405);
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
        expect((await instance.inject(request)).statusCode).toBe(429);
      }
    } finally {
      await replica.close();
    }
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
