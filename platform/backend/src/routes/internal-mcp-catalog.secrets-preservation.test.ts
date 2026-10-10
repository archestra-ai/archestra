import { vi } from "vitest";
import { betterAuth } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { InternalMcpCatalogModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { User } from "@/types";
import { deriveKeyFromSecret, encryptSecretValueWithKey } from "@/utils/crypto";

setupTestCacheManager();

describe("Internal MCP Catalog - Local Config Secret Preservation on PUT", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    registerAuditLogHook(app);
    await app.register(routes);
    await app.register((await import("./oauth")).default);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("unreadable local credentials allow metadata edits, reject partial replacement, and recover on complete replacement", async () => {
    const secret = await SecretModel.create({
      name: "unreadable-local",
      secret: {},
    });
    const encrypted = encryptSecretValueWithKey(
      { TOKEN: "old-token", OTHER: "old-other" },
      deriveKeyFromSecret("unavailable-test-key"),
    );
    await SecretModel.updateRawSecret(secret.id, encrypted);
    const localConfig = {
      command: "node",
      environment: [
        { key: "TOKEN", type: "secret" as const, promptOnInstallation: false },
        { key: "OTHER", type: "secret" as const, promptOnInstallation: false },
      ],
    };
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "unreadable-local-catalog",
        serverType: "local",
        localConfigSecretId: secret.id,
        localConfig,
      },
      { organizationId, authorId: user.id },
    );
    const url = `/api/internal_mcp_catalog/${catalog.id}`;
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { description: "Metadata edit" },
        })
      ).statusCode,
    ).toBe(200);
    const partial = await app.inject({
      method: "PUT",
      url,
      payload: {
        name: "must-not-rename-on-incomplete-recovery",
        localConfig: {
          ...localConfig,
          environment: [
            { ...localConfig.environment[0], value: "replacement-token" },
            localConfig.environment[1],
          ],
        },
      },
    });
    expect(partial.statusCode).toBe(409);
    expect(
      (
        await InternalMcpCatalogModel.findById(catalog.id, {
          expandSecrets: false,
        })
      )?.name,
    ).toBe(catalog.name);
    expect(partial.json().error.message).toContain("re-enter");
    expect(
      (await SecretModel.findAllRaw()).find((row) => row.id === secret.id)
        ?.secret,
    ).toEqual(encrypted);
    const response = await app.inject({
      method: "PUT",
      url,
      payload: {
        localConfig: {
          ...localConfig,
          environment: [
            { ...localConfig.environment[0], value: "replacement-token" },
            { ...localConfig.environment[1], value: "replacement-other" },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const recovered = await InternalMcpCatalogModel.findByIdWithResolvedSecrets(
      catalog.id,
    );
    expect(recovered?.localConfigSecretId).not.toBe(secret.id);
    expect(
      recovered?.localConfig?.environment?.map((entry) => entry.value),
    ).toEqual(["replacement-token", "replacement-other"]);
    // onResponse audit writes finish asynchronously.
    await vi.waitFor(async () => {
      const records = await AuditLogModel.findPaginated({
        organizationId,
        resourceId: catalog.id,
        action: "internalMcpCatalog.updated",
        limit: 10,
        offset: 0,
        sortDirection: "desc",
      });
      const record = records.data.find((entry) =>
        JSON.stringify(entry.after).includes(
          recovered?.localConfigSecretId ?? "missing",
        ),
      );
      expect(record).toBeDefined();
      expect(record?.after).not.toEqual(record?.before);
      expect(JSON.stringify(record)).not.toContain("replacement-token");
    });
  });

  test("complete OAuth credential re-entry restores runtime resolution", async () => {
    const secret = await SecretModel.create({
      name: "unreadable-oauth",
      secret: {},
    });
    await SecretModel.updateRawSecret(
      secret.id,
      encryptSecretValueWithKey(
        { client_secret: "old-secret" },
        deriveKeyFromSecret("unavailable-test-key"),
      ),
    );
    const oauthConfig = {
      name: "Synthetic OAuth",
      server_url: "https://example.invalid/mcp",
      client_id: "synthetic-client",
      redirect_uris: ["https://example.invalid/oauth-callback"],
      scopes: ["read"],
      default_scopes: [],
      supports_resource_metadata: false,
      requires_proxy: true,
      authorization_endpoint: "https://example.invalid/authorize",
      token_endpoint: "https://example.invalid/token",
    };
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "unreadable-oauth-catalog",
        serverType: "remote",
        serverUrl: "https://example.invalid/mcp",
        clientSecretId: secret.id,
        oauthConfig,
      },
      { organizationId, authorId: user.id },
    );
    const initiate = () =>
      app.inject({
        method: "POST",
        url: "/api/oauth/initiate",
        payload: { catalogId: catalog.id },
      });
    const unavailable = await initiate();
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.headers["x-should-retry"]).toBe("false");
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        oauthConfig: { ...oauthConfig, client_secret: "replacement-oauth" },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findByIdWithResolvedSecrets(catalog.id))
        ?.oauthConfig?.client_secret,
    ).toBe("replacement-oauth");
    const initiated = await initiate();
    expect(initiated.statusCode).toBe(200);
    expect(
      new URL(initiated.json().authorizationUrl).searchParams.get("client_id"),
    ).toBe("synthetic-client");
  });

  test("1. PUT with env var entry but no value preserves the stored secret value", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "preserve-no-value",
      secret: { API_KEY: "kept-value-1" },
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "preserve-no-value-catalog",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: catalog.name,
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
              // value omitted entirely (masked, unedited row)
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const stored = await secretManager().getSecret(existingSecret.id);
    expect(stored?.secret).toEqual({ API_KEY: "kept-value-1" });
  });

  test("2. PUT with env var entry and empty-string value preserves the stored secret value", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "preserve-empty-string",
      secret: { API_KEY: "kept-value-2" },
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "preserve-empty-string-catalog",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: catalog.name,
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
              value: "",
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const stored = await secretManager().getSecret(existingSecret.id);
    expect(stored?.secret).toEqual({ API_KEY: "kept-value-2" });
  });

  test("3. PUT updates one secret while preserving the other", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "preserve-mixed",
      secret: {
        EDITED_KEY: "old-edited",
        UNTOUCHED_KEY: "old-untouched",
      },
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "preserve-mixed-catalog",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "EDITED_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
            {
              key: "UNTOUCHED_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: catalog.name,
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "EDITED_KEY",
              type: "secret",
              promptOnInstallation: false,
              value: "new-edited",
            },
            {
              key: "UNTOUCHED_KEY",
              type: "secret",
              promptOnInstallation: false,
              // value omitted: untouched stored value should remain
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const stored = await secretManager().getSecret(existingSecret.id);
    expect(stored?.secret).toEqual({
      EDITED_KEY: "new-edited",
      UNTOUCHED_KEY: "old-untouched",
    });
  });

  test("4. PUT removing an env var entry drops its stored secret value", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "preserve-removed",
      secret: {
        KEPT_KEY: "kept-value",
        DROPPED_KEY: "dropped-value",
      },
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "preserve-removed-catalog",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "KEPT_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
            {
              key: "DROPPED_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: catalog.name,
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "KEPT_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const stored = await secretManager().getSecret(existingSecret.id);
    expect(stored?.secret).toEqual({ KEPT_KEY: "kept-value" });
    expect(stored?.secret).not.toHaveProperty("DROPPED_KEY");
  });

  test("5. PUT adding a new secret entry without a value does not insert an empty secret", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "preserve-new-empty",
      secret: { EXISTING_KEY: "existing-value" },
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "preserve-new-empty-catalog",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "EXISTING_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: catalog.name,
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "EXISTING_KEY",
              type: "secret",
              promptOnInstallation: false,
            },
            {
              key: "BRAND_NEW_KEY",
              type: "secret",
              promptOnInstallation: false,
              // user added the row but did not type a value
            },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const stored = await secretManager().getSecret(existingSecret.id);
    expect(stored?.secret).toEqual({ EXISTING_KEY: "existing-value" });
    expect(stored?.secret).not.toHaveProperty("BRAND_NEW_KEY");
  });
});
