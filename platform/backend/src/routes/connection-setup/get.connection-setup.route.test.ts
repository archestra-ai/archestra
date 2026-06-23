import { ConnectionSetupModel } from "@/models";
import { CONNECTION_SETUP_TOKEN_TTL_MS } from "@/models/connection-setup";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/connection-setups/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

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

  const createSetup = () =>
    ConnectionSetupModel.create({
      organizationId,
      userId: user.id,
      clientId: "claude-code",
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: null,
      llmProxyId: null,
      provider: null,
      proxyAuth: "provider-key",
      virtualApiKeyId: null,
      includeSkills: false,
      skillLinkTtlDays: null,
      skillIds: [],
      expiresAt: new Date(Date.now() + CONNECTION_SETUP_TOKEN_TTL_MS),
    });

  test("reports an unconsumed setup before its command runs", async () => {
    const { setup } = await createSetup();

    const response = await app.inject({
      method: "GET",
      url: `/api/connection-setups/${setup.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(setup.id);
    expect(body.consumed).toBe(false);
    expect(body.consumedAt).toBeNull();
  });

  test("flips to consumed once the script token is claimed", async () => {
    const { setup, rawToken } = await createSetup();

    // Running the command consumes the one-time token server-side.
    await ConnectionSetupModel.claimByToken({ rawToken });

    const response = await app.inject({
      method: "GET",
      url: `/api/connection-setups/${setup.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.consumed).toBe(true);
    expect(body.consumedAt).not.toBeNull();
  });

  test("404s an unknown setup id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/connection-setups/3e0c8d4e-7a8b-4f43-9e1d-2f56a1b6c7d8",
    });

    expect(response.statusCode).toBe(404);
  });

  test("404s a setup owned by another user without leaking it", async ({
    makeUser,
    makeMember,
  }) => {
    const otherUser = await makeUser();
    await makeMember(otherUser.id, organizationId);
    const { setup } = await ConnectionSetupModel.create({
      organizationId,
      userId: otherUser.id,
      clientId: "claude-code",
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      mcpGatewayId: null,
      llmProxyId: null,
      provider: null,
      proxyAuth: "provider-key",
      virtualApiKeyId: null,
      includeSkills: false,
      skillLinkTtlDays: null,
      skillIds: [],
      expiresAt: new Date(Date.now() + CONNECTION_SETUP_TOKEN_TTL_MS),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/connection-setups/${setup.id}`,
    });

    expect(response.statusCode).toBe(404);
  });
});
