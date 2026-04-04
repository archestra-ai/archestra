import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { createApiKeyMock, deleteApiKeyMock } = vi.hoisted(() => ({
  createApiKeyMock: vi.fn(),
  deleteApiKeyMock: vi.fn(),
}));

vi.mock("@/auth/better-auth", () => ({
  auth: {
    api: {
      createApiKey: createApiKeyMock,
      deleteApiKey: deleteApiKeyMock,
    },
  },
}));

describe("api key routes", () => {
  let app: FastifyInstanceWithZod;
  let userId: string;
  let user: User;
  let otherUserId: string;

  beforeEach(async ({ makeUser }) => {
    vi.clearAllMocks();
    user = await makeUser();
    const otherUser = await makeUser();
    userId = user.id;
    otherUserId = otherUser.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
    });

    const { default: apiKeyRoutes } = await import("./api-key");
    await app.register(apiKeyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns a generic create error message instead of exposing upstream details", async () => {
    createApiKeyMock.mockRejectedValue(
      Object.assign(new Error("better auth internals leaked"), {
        statusCode: 400,
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/api-keys",
      payload: {
        name: "CLI Key",
        expiresIn: 3600,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "Failed to create API key",
        type: "api_validation_error",
      },
    });
  });

  test("lists the authenticated user's API keys only", async () => {
    await db.insert(schema.apikeysTable).values([
      {
        id: "key-1",
        configId: "default",
        name: "CLI Key",
        key: "hashed-key-1",
        referenceId: userId,
        enabled: true,
        createdAt: new Date("2026-03-15T00:00:00.000Z"),
        updatedAt: new Date("2026-03-15T00:00:00.000Z"),
      },
      {
        id: "key-2",
        configId: "default",
        name: "Docs Key",
        key: "hashed-key-2",
        referenceId: userId,
        enabled: true,
        createdAt: new Date("2026-03-14T00:00:00.000Z"),
        updatedAt: new Date("2026-03-14T00:00:00.000Z"),
      },
      {
        id: "key-3",
        configId: "default",
        name: "Other User Key",
        key: "hashed-key-3",
        referenceId: otherUserId,
        enabled: true,
        createdAt: new Date("2026-03-13T00:00:00.000Z"),
        updatedAt: new Date("2026-03-13T00:00:00.000Z"),
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/api-keys",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      { id: "key-1", name: "CLI Key" },
      { id: "key-2", name: "Docs Key" },
    ]);
  });

  test("gets one API key by id for the authenticated user", async () => {
    await db.insert(schema.apikeysTable).values({
      id: "key-1",
      configId: "default",
      name: "CLI Key",
      key: "hashed-key-1",
      referenceId: userId,
      enabled: true,
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
      updatedAt: new Date("2026-03-15T00:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/api-keys/key-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "key-1",
      name: "CLI Key",
      userId,
    });
  });

  test("returns 404 when an API key does not belong to the authenticated user", async () => {
    await db.insert(schema.apikeysTable).values({
      id: "key-1",
      configId: "default",
      name: "Other User Key",
      key: "hashed-key-1",
      referenceId: otherUserId,
      enabled: true,
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
      updatedAt: new Date("2026-03-15T00:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/api-keys/key-1",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "API key not found",
        type: "api_not_found_error",
      },
    });
  });

  test("normalizes a successful create response", async () => {
    createApiKeyMock.mockResolvedValue({
      id: "key-1",
      configId: "default",
      name: "CLI Key",
      start: "archestra_abcd",
      prefix: "archestra_",
      referenceId: userId,
      enabled: true,
      refillInterval: null,
      refillAmount: null,
      lastRefillAt: null,
      rateLimitEnabled: false,
      rateLimitTimeWindow: null,
      rateLimitMax: null,
      requestCount: 0,
      remaining: null,
      lastRequest: null,
      expiresAt: "2026-03-15T01:00:00.000Z",
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      metadata: { scope: "cli" },
      permissions: { apiKey: ["read"] },
      key: "archestra_abcd1234",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/api-keys",
      payload: {
        name: "CLI Key",
        expiresIn: 3600,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "key-1",
      name: "CLI Key",
      start: "archestra_abcd",
      prefix: "archestra_",
      key: "archestra_abcd1234",
      metadata: { scope: "cli" },
      permissions: { apiKey: ["read"] },
    });
  });

  test("omits a null name before calling better-auth createApiKey", async () => {
    createApiKeyMock.mockResolvedValue({
      id: "key-1",
      configId: "default",
      name: null,
      start: "archestra_abcd",
      prefix: "archestra_",
      referenceId: userId,
      enabled: true,
      refillInterval: null,
      refillAmount: null,
      lastRefillAt: null,
      rateLimitEnabled: false,
      rateLimitTimeWindow: null,
      rateLimitMax: null,
      requestCount: 0,
      remaining: null,
      lastRequest: null,
      expiresAt: null,
      createdAt: "2026-03-15T00:00:00.000Z",
      updatedAt: "2026-03-15T00:00:00.000Z",
      metadata: null,
      permissions: null,
      key: "archestra_abcd1234",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/api-keys",
      payload: {
        name: null,
        expiresIn: 3600,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          expiresIn: 3600,
        },
      }),
    );
  });

  test("maps upstream delete 404 errors to a safe API key message", async () => {
    await db.insert(schema.apikeysTable).values({
      id: "key-1",
      configId: "default",
      name: "Existing key",
      key: "hashed-key-1",
      referenceId: userId,
      enabled: true,
      createdAt: new Date("2026-03-15T00:00:00.000Z"),
      updatedAt: new Date("2026-03-15T00:00:00.000Z"),
    });
    deleteApiKeyMock.mockRejectedValue(
      Object.assign(new Error("missing key in auth store"), {
        statusCode: 404,
      }),
    );

    const response = await app.inject({
      method: "DELETE",
      url: "/api/api-keys/key-1",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        message: "API key not found",
        type: "api_not_found_error",
      },
    });
  });

  test("returns 404 before calling upstream delete when the API key is missing", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/api-keys/missing-key",
    });

    expect(response.statusCode).toBe(404);
    expect(deleteApiKeyMock).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: {
        message: "API key not found",
        type: "api_not_found_error",
      },
    });
  });
});
