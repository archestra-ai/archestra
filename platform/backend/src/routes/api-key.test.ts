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

  beforeEach(async ({ makeUser }) => {
    vi.clearAllMocks();
    user = await makeUser();
    userId = user.id;

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

  test("maps upstream delete 404 errors to a safe API key message", async () => {
    await db.insert(schema.apikeysTable).values({
      id: "key-1",
      name: "Existing key",
      key: "hashed-key-1",
      userId,
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
});
