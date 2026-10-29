import { STARTUP_GUARD_FORMAT_VERSION } from "@archestra/shared";
import { PLUGIN_DELIVERY_MAX_COUNT } from "@archestra/shared/connection-setup";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { authPlugin } from "@/auth/fastify-plugin";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";

vi.mock("@/cache-manager");

describe("POST /api/connection-setups/startup-guard", () => {
  let app: FastifyInstanceWithZod;
  beforeEach(async () => {
    app = createFastifyInstance();
    const { default: routes } = await import("./connection-setup.routes");
    await app.register(authPlugin);
    await app.register(routes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });
  const payload = {
    clientId: "claude-code",
    platform: "bash",
    context: {
      appName: "Archestra",
      healthUrl: "https://example.com/v1/health?mcp=test",
      mcp: {
        serverName: "test",
        url: "https://example.com/v1/mcp/test",
        ref: "test",
      },
      proxy: null,
      skills: null,
    },
  };
  test("renders a public artifact with no login or setup mutation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/startup-guard",
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      clientId: "claude-code",
      platform: "bash",
      version: STARTUP_GUARD_FORMAT_VERSION,
    });
    expect(response.json().source).toContain("GUARD_FORMAT_VERSION=");
    expect(response.json().source).not.toContain("permissions.allow");
  });
  test("rejects credential-bearing render parameters and unknown clients", async () => {
    const secret = await app.inject({
      method: "POST",
      url: "/api/connection-setups/startup-guard",
      payload: {
        ...payload,
        context: {
          ...payload.context,
          skills: {
            marketplaceName: "test",
            cloneUrl: "https://user:secret@example.com/marketplace.git",
          },
        },
      },
    });
    expect(secret.statusCode).toBe(400);
    const client = await app.inject({
      method: "POST",
      url: "/api/connection-setups/startup-guard",
      payload: { ...payload, clientId: "unknown" },
    });
    expect(client.statusCode).toBe(400);
  });
  test("refreshes a setup containing the supported maximum plugin selection", async () => {
    const pluginNames = Array.from(
      { length: PLUGIN_DELIVERY_MAX_COUNT },
      (_, index) => `fixture-plugin-${index}`,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups/startup-guard",
      payload: {
        ...payload,
        context: {
          ...payload.context,
          skills: {
            marketplaceName: "fixture",
            cloneUrl: "ARCH_GUARD_PRIVATE_CLONE_URL",
            pluginNames,
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().source).toContain(
      pluginNames[pluginNames.length - 1],
    );
  });
  test("does not allow a public render request to authenticate other routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connection-setups",
      payload: {
        clientId: "claude-code",
        platform: "macos",
        baseUrl: "https://example.com",
      },
    });
    expect(response.statusCode).toBe(401);
  });
});
