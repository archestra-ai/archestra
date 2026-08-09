import { vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    frontendBaseUrl: "https://archestra.example.com",
    auth: { secret: "test-signing-secret" },
    kb: {
      googleDriveOAuth: {
        clientId: "client-abc.apps.googleusercontent.com",
        clientSecret: "client-secret-xyz",
      },
    },
  }),
);

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue("task-1"));
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: mockEnqueue },
}));

const mockGetToken = vi.hoisted(() => vi.fn());
const mockAboutGet = vi.hoisted(() => vi.fn());
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials = vi.fn();
    getToken = (...args: unknown[]) => mockGetToken(...args);
    generateAuthUrl = (options: { state: string }) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(options.state)}`;
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2, GoogleAuth: class {} },
      drive: () => ({
        about: { get: (...a: unknown[]) => mockAboutGet(...a) },
      }),
      admin: () => ({ users: { list: vi.fn() } }),
    },
  };
});

import { KnowledgeBaseConnectorModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("Google Drive individual (OAuth) connection", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    mockEnqueue.mockClear();
    mockGetToken.mockReset();
    mockAboutGet.mockReset();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./knowledge-base");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function createOAuthConnector() {
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: {
        name: `gdrive-${crypto.randomUUID().slice(0, 8)}`,
        connectorType: "gdrive",
        config: { type: "gdrive", authMode: "oauth" },
      },
    });
    return response;
  }

  test("creates without a pasted credential and holds off the first sync", async () => {
    const response = await createOAuthConnector();

    expect(response.statusCode).toBe(200);
    const connector = response.json();

    // Nothing to sync with yet: a run now could only fail, restating what the
    // connector page already says.
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(connector.lastSyncStatus).toBeNull();

    // The secret exists from the start, carrying the client the connector
    // will be authorized against and no token.
    const stored = await secretManager().getSecret(connector.secretId);
    expect(stored?.secret).toMatchObject({
      googleOAuth: { clientId: "client-abc.apps.googleusercontent.com" },
    });
    expect(
      (stored?.secret as { googleOAuth: { refreshToken?: string } }).googleOAuth
        .refreshToken,
    ).toBeUndefined();
  });

  test("rejects inline credentials for an individual-mode connector", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/connectors",
      payload: {
        name: "gdrive-smuggled",
        connectorType: "gdrive",
        config: { type: "gdrive", authMode: "oauth" },
        credentials: { apiToken: "pasted-token" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "authorized through Google",
    );
  });

  test("the whole round trip stores the refresh token and starts the sync", async () => {
    const created = (await createOAuthConnector()).json();

    const start = await app.inject({
      method: "POST",
      url: `/api/connectors/${created.id}/gdrive/oauth/start`,
      payload: {
        returnTo: `https://archestra.example.com/knowledge/connectors/${created.id}`,
      },
    });
    expect(start.statusCode).toBe(200);

    const authorizationUrl = new URL(start.json().authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    mockGetToken.mockResolvedValueOnce({
      tokens: { refresh_token: "refresh-token-1" },
    });
    mockAboutGet.mockResolvedValueOnce({
      data: { user: { emailAddress: "person@example.com" } },
    });

    const callback = await app.inject({
      method: "GET",
      url: `/api/connectors/gdrive/oauth/callback?code=auth-code&state=${encodeURIComponent(state ?? "")}`,
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain(
      `/knowledge/connectors/${created.id}`,
    );
    expect(callback.headers.location).toContain("gdriveConnected=");

    const stored = await secretManager().getSecret(created.secretId);
    expect(stored?.secret).toMatchObject({
      googleOAuth: {
        clientId: "client-abc.apps.googleusercontent.com",
        refreshToken: "refresh-token-1",
      },
    });

    // The connected account is on the config so the page can name it without
    // unsealing a secret.
    const after = await KnowledgeBaseConnectorModel.findById(created.id);
    expect(after?.config).toMatchObject({
      connectedAccountEmail: "person@example.com",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      taskType: "connector_sync",
      payload: { connectorId: created.id },
    });
  });

  test("a callback with a forged state writes nothing", async () => {
    const created = (await createOAuthConnector()).json();

    const callback = await app.inject({
      method: "GET",
      url: "/api/connectors/gdrive/oauth/callback?code=auth-code&state=forged.signature",
    });

    // Redirected with an explanation rather than 500ing at the browser, and
    // no token was exchanged for the attacker-named connector.
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("gdriveOauthError=");
    expect(mockGetToken).not.toHaveBeenCalled();

    const stored = await secretManager().getSecret(created.secretId);
    expect(
      (stored?.secret as { googleOAuth: { refreshToken?: string } }).googleOAuth
        .refreshToken,
    ).toBeUndefined();
  });

  test("a declined authorization comes back as a cancellation, not an error page", async () => {
    const callback = await app.inject({
      method: "GET",
      url: "/api/connectors/gdrive/oauth/callback?error=access_denied",
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("cancelled");
  });

  test("refuses to start the flow for a connector that is not in individual mode", async () => {
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId,
      name: "gdrive-service-account",
      connectorType: "gdrive",
      config: { type: "gdrive", authMode: "service_account" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/connectors/${connector.id}/gdrive/oauth/start`,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
