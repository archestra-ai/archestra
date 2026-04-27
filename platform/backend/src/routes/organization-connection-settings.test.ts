import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { hasPermissionMock } = vi.hoisted(() => ({
  hasPermissionMock: vi.fn(),
}));

vi.mock("@/auth", async () => {
  const actual = await vi.importActual<typeof import("@/auth")>("@/auth");
  return {
    ...actual,
    hasPermission: hasPermissionMock,
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: {
        ...actual.default.enterpriseFeatures,
        core: true,
      },
    },
  };
});

describe("PATCH /api/organization/connection-settings", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true });

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: unknown;
          organizationId: string;
        }
      ).user = adminUser;
      (
        request as typeof request & {
          user: { id: string };
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("persists admin defaults and hidden lists", async ({ makeAgent }) => {
    const gateway = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "mcp_gateway",
      name: "Admin Default Gateway",
    });
    const proxy = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "llm_proxy",
      name: "Admin Default Proxy",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: {
        connectionDefaultMcpGatewayId: gateway.id,
        connectionDefaultLlmProxyId: proxy.id,
        connectionShownClientIds: ["claude-code"],
        connectionShownProviders: ["openai", "anthropic"],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.connectionDefaultMcpGatewayId).toBe(gateway.id);
    expect(body.connectionDefaultLlmProxyId).toBe(proxy.id);
    expect(body.connectionShownClientIds).toEqual(["claude-code"]);
    expect(body.connectionShownProviders).toEqual(["openai", "anthropic"]);
  });

  test("rejects a gateway that belongs to another organization", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    const foreignGateway = await makeAgent({
      organizationId: otherOrg.id,
      authorId: otherUser.id,
      agentType: "mcp_gateway",
      name: "Foreign Gateway",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: {
        connectionDefaultMcpGatewayId: foreignGateway.id,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  test("rejects a wrong-type agent for the gateway slot", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "llm_proxy",
      name: "Not a gateway",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: {
        connectionDefaultMcpGatewayId: proxy.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects a proxy that belongs to another organization", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const otherOrg = await makeOrganization();
    const otherUser = await makeUser();
    const foreignProxy = await makeAgent({
      organizationId: otherOrg.id,
      authorId: otherUser.id,
      agentType: "llm_proxy",
      name: "Foreign Proxy",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: {
        connectionDefaultLlmProxyId: foreignProxy.id,
      },
    });

    expect(response.statusCode).toBe(404);
  });

  test("rejects a wrong-type agent for the proxy slot", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "mcp_gateway",
      name: "Not a proxy",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: {
        connectionDefaultLlmProxyId: gateway.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("persists and clears the default client id", async () => {
    const setResponse = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: { connectionDefaultClientId: "cursor" },
    });
    expect(setResponse.statusCode).toBe(200);
    expect(setResponse.json().connectionDefaultClientId).toBe("cursor");

    const clearResponse = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: { connectionDefaultClientId: null },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json().connectionDefaultClientId).toBeNull();
  });

  test("allows clearing defaults with null", async ({ makeAgent }) => {
    const gateway = await makeAgent({
      organizationId,
      authorId: adminUser.id,
      agentType: "mcp_gateway",
      name: "Temp Gateway",
    });

    await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: { connectionDefaultMcpGatewayId: gateway.id },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/connection-settings",
      payload: { connectionDefaultMcpGatewayId: null },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().connectionDefaultMcpGatewayId).toBeNull();
  });
});
