import { vi } from "vitest";
import { ConnectionSetupModel, VirtualApiKeyModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

// cacheManager needs a live PostgreSQL connection that PGlite tests don't
// have; back it with a Map (same convention as src/agents/utils.test.ts).
const mockCache = new Map<string, unknown>();
vi.mock("@/cache-manager", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/cache-manager")>();
  return {
    ...original,
    cacheManager: {
      get: vi.fn(async (key: string) => mockCache.get(key)),
      set: vi.fn(async (key: string, value: unknown) => {
        mockCache.set(key, value);
        return true;
      }),
      delete: vi.fn(async (key: string) => mockCache.delete(key)),
    },
  };
});

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("POST /api/connection-setups", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: connectionSetupRoutes } = await import(
      "./connection-setup.routes"
    );
    await app.register(connectionSetupRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("rejects a setup with no sections selected", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: { clientId: "claude-code", baseUrl: "http://localhost:9000/v1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("at least one");
  });

  test("rejects provider without proxy and proxy without provider", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const providerOnly = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        provider: "anthropic",
      },
    });
    expect(providerOnly.statusCode).toBe(400);

    const proxyOnly = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
      },
    });
    expect(proxyOnly.statusCode).toBe(400);
  });

  test("rejects a provider the client cannot speak to", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "openai",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not supported");
  });

  test("rejects a baseUrl outside the deployment's allowed endpoints", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "https://attacker.example.com/v1",
        mcpGatewayId: gateway.id,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not an allowed");
  });

  test("allowlist: normalizes and matches exact URLs, not just hosts", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    const post = (baseUrl: string) =>
      app.inject({
        method: "POST",
        url: "/api/connection-setups",
        payload: { clientId: "claude-code", baseUrl, mcpGatewayId: gateway.id },
      });

    // localhost: only "" or "/v1" paths, trailing slashes tolerated
    expect((await post("http://localhost:9000/v1/")).statusCode).toBe(200);
    expect((await post("http://localhost:9000")).statusCode).toBe(200);
    expect(
      (await post("http://localhost:9000/v1$(touch /tmp/pwned)")).statusCode,
    ).toBe(400);
    expect((await post("http://localhost:9000/v1/extra")).statusCode).toBe(400);
    // query strings and fragments never pass
    expect((await post("http://localhost:9000/v1?x=1")).statusCode).toBe(400);
    // same host as an allowed source but with a smuggled path is rejected
    expect(
      (await post("https://allowed.example.com/v1/../evil")).statusCode,
    ).toBe(400);
  });

  test("allowlist: accepts admin-curated org connection URLs incl. /v1 suffix", async ({
    makeAgent,
  }) => {
    const { OrganizationModel } = await import("@/models");
    await OrganizationModel.patch(organizationId, {
      connectionBaseUrls: [
        {
          url: "https://api.acme-corp.example.com",
          description: "",
          isDefault: false,
          visible: true,
        },
      ],
    });
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "https://api.acme-corp.example.com/v1",
        mcpGatewayId: gateway.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().command).toContain(
      "https://api.acme-corp.example.com/api/connection-setups/script/",
    );
  });

  test("404s a gateway from another organization without leaking it", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignGateway = await makeAgent({
      organizationId: otherOrg.id,
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        mcpGatewayId: foreignGateway.id,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("MCP gateway not found");
  });

  test("403s skills inclusion without skill admin", async () => {
    mockUserHasPermission.mockImplementation(
      async (_userId, _orgId, resource) => resource !== "skill",
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        skills: {
          skillIds: ["3e0c8d4e-7a8b-4f43-9e1d-2f56a1b6c7d8"],
          ttlDays: 30,
        },
      },
    });

    expect(response.statusCode).toBe(403);
  });

  test("creates the setup, the one-liner command, and the personal virtual key", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      name: "Prod Gateway",
    });
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "anthropic",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        mcpGatewayId: gateway.id,
        llmProxyId: proxy.id,
        provider: "anthropic",
        proxyAuth: "virtual-key",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.command).toMatch(
      /^curl -fsSL 'http:\/\/localhost:9000\/api\/connection-setups\/script\/archestra_con_[A-Za-z0-9_-]+' \| bash$/,
    );
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // command contains the raw token, which is never persisted
    const rawToken = body.command.match(/script\/([^']+)'/)?.[1] as string;
    const setup = await ConnectionSetupModel.findByToken(rawToken);
    expect(setup?.id).toBe(body.id);
    expect(setup?.tokenHash).not.toContain(rawToken);

    // a personal virtual key was silently provisioned for the user
    expect(setup?.virtualApiKeyId).toBeTruthy();
    const virtualKey = await VirtualApiKeyModel.findById(
      setup?.virtualApiKeyId as string,
    );
    expect(virtualKey?.scope).toBe("personal");
    expect(virtualKey?.authorId).toBe(user.id);
  });

  test("virtual-key mode 400s when no provider API key is configured; passthrough doesn't need one", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const virtualKeyMode = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "anthropic",
        proxyAuth: "virtual-key",
      },
    });
    expect(virtualKeyMode.statusCode).toBe(400);
    expect(virtualKeyMode.json().error.message).toContain(
      "No anthropic API key",
    );

    // provider-key passthrough with attribution off: nothing to provision
    const passthrough = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "anthropic",
        attributePassthrough: false,
      },
    });
    expect(passthrough.statusCode).toBe(200);
    const rawToken = passthrough
      .json()
      .command.match(/script\/([^']+)'/)?.[1] as string;
    const setup = await ConnectionSetupModel.findByToken(rawToken);
    expect(setup?.proxyAuth).toBe("provider-key");
    expect(setup?.virtualApiKeyId).toBeNull();
  });

  test("claude-code anthropic passthrough provisions an attribution key by default", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "anthropic",
      },
    });
    expect(response.statusCode).toBe(200);
    const rawToken = response
      .json()
      .command.match(/script\/([^']+)'/)?.[1] as string;
    const setup = await ConnectionSetupModel.findByToken(rawToken);
    expect(setup?.proxyAuth).toBe("provider-key");
    expect(setup?.virtualApiKeyId).not.toBeNull();
    const attributionKey = await VirtualApiKeyModel.findById(
      setup?.virtualApiKeyId as string,
    );
    expect(attributionKey?.keyType).toBe("passthrough");
    expect(attributionKey?.authorId).toBe(user.id);
  });

  test("passthrough attribution is best-effort: still 200 without llmVirtualKey:create, no key provisioned", async ({
    makeAgent,
  }) => {
    mockUserHasPermission.mockImplementation(
      async (_userId, _orgId, resource, action) =>
        !(resource === "llmVirtualKey" && action === "create"),
    );
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "anthropic",
      },
    });
    expect(response.statusCode).toBe(200);
    const rawToken = response
      .json()
      .command.match(/script\/([^']+)'/)?.[1] as string;
    const setup = await ConnectionSetupModel.findByToken(rawToken);
    expect(setup?.virtualApiKeyId).toBeNull();
  });

  test("virtual-key mode 403s without llmVirtualKey:create permission", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    mockUserHasPermission.mockImplementation(
      async (_userId, _orgId, resource, action) =>
        !(resource === "llmVirtualKey" && action === "create"),
    );
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });
    await makeLlmProviderApiKey(organizationId, (await makeSecret()).id, {
      provider: "anthropic",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "anthropic",
        proxyAuth: "virtual-key",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("llmVirtualKey:create");
  });

  test("uses the admin-configured default provider key for auto-provisioning", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });
    // a personal key that would win the precedence guess...
    const personalKey = await makeLlmProviderApiKey(
      organizationId,
      (await makeSecret()).id,
      { provider: "anthropic", scope: "personal", userId: user.id },
    );
    // ...and an org key the admin explicitly mapped as the connection default
    const mappedKey = await makeLlmProviderApiKey(
      organizationId,
      (await makeSecret()).id,
      { provider: "anthropic", scope: "org" },
    );
    const { OrganizationModel } = await import("@/models");
    await OrganizationModel.patch(organizationId, {
      connectionDefaultProviderKeys: { anthropic: mappedKey.id },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        baseUrl: "http://localhost:9000/v1",
        llmProxyId: proxy.id,
        provider: "anthropic",
        proxyAuth: "virtual-key",
      },
    });
    expect(response.statusCode).toBe(200);

    const rawToken = response
      .json()
      .command.match(/script\/([^']+)'/)?.[1] as string;
    const setup = await ConnectionSetupModel.findByToken(rawToken);
    const mappings = await VirtualApiKeyModel.getProviderApiKeys(
      setup?.virtualApiKeyId as string,
    );
    expect(mappings).toEqual([
      expect.objectContaining({ providerApiKeyId: mappedKey.id }),
    ]);
    expect(personalKey.id).not.toBe(mappedKey.id);
  });
});
