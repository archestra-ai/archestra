import { ADMIN_ROLE_NAME } from "@shared";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const { getSessionMock, hasPermissionMock, verifyApiKeyMock } = vi.hoisted(
  () => ({
    getSessionMock: vi.fn(),
    hasPermissionMock: vi.fn(),
    verifyApiKeyMock: vi.fn(),
  }),
);

vi.mock("@/auth/better-auth", () => ({
  auth: {
    api: {
      getSession: getSessionMock,
      hasPermission: hasPermissionMock,
      verifyApiKey: verifyApiKeyMock,
    },
  },
}));

describe("API key route authorization", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = createFastifyInstance();
    const { fastifyAuthPlugin } = await import("@/auth");
    const { default: apiKeyRoutes } = await import("./api-key");
    await app.register(fastifyAuthPlugin);
    await app.register(apiKeyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("allows a protected route when API key owner has required permissions and key metadata is null", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    await db.insert(schema.apikeysTable).values({
      id: "route-key-1",
      configId: "default",
      name: "CLI Key",
      key: "hashed-key-1",
      referenceId: user.id,
      enabled: true,
      metadata: null,
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
      updatedAt: new Date("2026-03-15T00:00:00.000Z"),
    });

    getSessionMock.mockRejectedValue(new Error("No session"));
    hasPermissionMock.mockRejectedValue(new Error("No active organization"));
    verifyApiKeyMock.mockResolvedValue({
      valid: true,
      error: null,
      key: {
        id: "route-key-1",
        referenceId: user.id,
        metadata: null,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/api-keys",
      headers: {
        authorization: "archestra_test_key",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: "route-key-1",
        name: "CLI Key",
        userId: user.id,
        metadata: null,
      },
    ]);
    expect(verifyApiKeyMock).toHaveBeenCalledWith({
      body: { key: "archestra_test_key" },
    });
  });

  test("rejects a protected route when API key owner lacks required permissions", async ({
    makeUser,
    makeOrganization,
    makeCustomRole,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    const role = await makeCustomRole(organization.id, {
      permission: { agent: ["read"] },
    });
    await makeMember(user.id, organization.id, { role: role.role });

    getSessionMock.mockRejectedValue(new Error("No session"));
    hasPermissionMock.mockRejectedValue(new Error("No active organization"));
    verifyApiKeyMock.mockResolvedValue({
      valid: true,
      error: null,
      key: {
        id: "route-key-2",
        referenceId: user.id,
        metadata: null,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/api-keys",
      headers: {
        authorization: "archestra_limited_key",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        message: "Forbidden",
        type: "api_authorization_error",
      },
    });
  });
});
