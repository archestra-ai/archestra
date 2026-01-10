/**
 * Tests for browser-stream routes when the feature flag is DISABLED.
 * This is in a separate file because the feature check happens at route registration time,
 * so we need to mock the config before importing the routes.
 */
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Mock config to disable the feature BEFORE importing routes
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      features: {
        ...actual.default.features,
        browserStreamingEnabled: false, // Feature is disabled
      },
    },
  };
});

// Import routes AFTER mocking config (dynamic import needed because of the mock)
const { default: browserStreamRoutes } = await import("./browser-stream");

const buildAppWithUser = async (user: User, organizationId: string) => {
  const app = Fastify({ logger: false })
    .withTypeProvider<ZodTypeProvider>()
    .setValidatorCompiler(validatorCompiler)
    .setSerializerCompiler(serializerCompiler);

  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", async (request) => {
    request.user = user;
    request.organizationId = organizationId;
  });

  await app.register(browserStreamRoutes);
  await app.ready();
  return app;
};

describe("browser-stream routes when feature is disabled", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("GET /available returns 404 when feature is disabled", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = (await makeUser()) as User;

    const app = await buildAppWithUser(user, org.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/browser-stream/00000000-0000-0000-0000-000000000000/available",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "Browser streaming feature is disabled" },
    });

    await app.close();
  });

  test("POST /navigate returns 404 when feature is disabled", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = (await makeUser()) as User;

    const app = await buildAppWithUser(user, org.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/browser-stream/00000000-0000-0000-0000-000000000000/navigate",
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "Browser streaming feature is disabled" },
    });

    await app.close();
  });

  test("GET /screenshot returns 404 when feature is disabled", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = (await makeUser()) as User;

    const app = await buildAppWithUser(user, org.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/browser-stream/00000000-0000-0000-0000-000000000000/screenshot",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "Browser streaming feature is disabled" },
    });

    await app.close();
  });

  test("POST /activate returns 404 when feature is disabled", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = (await makeUser()) as User;

    const app = await buildAppWithUser(user, org.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/browser-stream/00000000-0000-0000-0000-000000000000/activate",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "Browser streaming feature is disabled" },
    });

    await app.close();
  });

  test("DELETE /tab returns 404 when feature is disabled", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = (await makeUser()) as User;

    const app = await buildAppWithUser(user, org.id);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/browser-stream/00000000-0000-0000-0000-000000000000/tab",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "Browser streaming feature is disabled" },
    });

    await app.close();
  });
});
