import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("Internal MCP Catalog - Local Config Secret Preservation on PUT", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
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
