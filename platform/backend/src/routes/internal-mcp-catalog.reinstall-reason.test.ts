import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * `reinstall_reason` distinguishes flagged installs whose stored credentials
 * are still valid ("restart": execution-config drift, retries) from those
 * owing new prompted values ("new-input"). The frontend keys the reinstall
 * dialog off it: "restart" gets a plain confirm + empty-body reinstall that
 * reuses the stored secret bag, "new-input" collects values.
 */
describe("PUT /api/internal_mcp_catalog/:id — reinstall reason", () => {
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

  const promptedAuthField = {
    type: "string",
    title: "Authorization",
    description: "Bearer token",
    required: true,
    sensitive: true,
    headerName: "Authorization",
    promptOnInstallation: true,
  };

  const baseLocalConfig = {
    command: "node",
    arguments: ["server.js"],
    dockerImage: "example/image:1.0",
    environment: [],
  };

  async function createCatalogWithInstall(
    makeMcpServer: (overrides: {
      catalogId: string;
      ownerId: string;
      scope: "personal";
    }) => Promise<{ id: string }>,
    name: string,
  ): Promise<{ catalogId: string; serverId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name,
        serverType: "local",
        localConfig: baseLocalConfig,
        userConfig: { authorization: promptedAuthField },
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    const catalog = response.json();
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
    });
    return { catalogId: catalog.id, serverId: server.id };
  }

  async function getServerRow(serverId: string) {
    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, serverId));
    return row;
  }

  test("docker-image-only PUT on a single-tenant catalog flags installs with reason 'restart' (stored credentials stay valid)", async ({
    makeMcpServer,
  }) => {
    const { catalogId, serverId } = await createCatalogWithInstall(
      makeMcpServer,
      "reason-image-bump",
    );

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: {
        name: "reason-image-bump",
        serverType: "local",
        localConfig: { ...baseLocalConfig, dockerImage: "example/image:2.0" },
        userConfig: { authorization: promptedAuthField },
      },
    });
    expect(putResponse.statusCode).toBe(200);

    const serverRow = await getServerRow(serverId);
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.reinstallReason).toBe("restart");
  });

  test("PUT adding a REQUIRED prompted env var flags installs with reason 'new-input'", async ({
    makeMcpServer,
  }) => {
    const { catalogId, serverId } = await createCatalogWithInstall(
      makeMcpServer,
      "reason-new-required-env",
    );

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: {
        name: "reason-new-required-env",
        serverType: "local",
        localConfig: {
          ...baseLocalConfig,
          environment: [
            {
              key: "API_TOKEN",
              type: "secret",
              sensitive: true,
              required: true,
              promptOnInstallation: true,
            },
          ],
        },
        userConfig: { authorization: promptedAuthField },
      },
    });
    expect(putResponse.statusCode).toBe(200);

    const serverRow = await getServerRow(serverId);
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.reinstallReason).toBe("new-input");
  });

  test("PUT combining an image bump WITH a new required prompted env var resolves to 'new-input' (owed input wins)", async ({
    makeMcpServer,
  }) => {
    const { catalogId, serverId } = await createCatalogWithInstall(
      makeMcpServer,
      "reason-combined-edit",
    );

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: {
        name: "reason-combined-edit",
        serverType: "local",
        localConfig: {
          ...baseLocalConfig,
          dockerImage: "example/image:3.0",
          environment: [
            {
              key: "API_TOKEN",
              type: "secret",
              sensitive: true,
              required: true,
              promptOnInstallation: true,
            },
          ],
        },
        userConfig: { authorization: promptedAuthField },
      },
    });
    expect(putResponse.statusCode).toBe(200);

    const serverRow = await getServerRow(serverId);
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.reinstallReason).toBe("new-input");
  });

  test("a prompted env var TYPE change resolves to 'new-input' even when the install holds a stored value (stale bucket, not missing value)", async ({
    makeMcpServer,
  }) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "reason-type-flip",
        serverType: "local",
        localConfig: {
          ...baseLocalConfig,
          environment: [
            {
              key: "API_TOKEN",
              type: "plain_text",
              required: true,
              promptOnInstallation: true,
            },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const catalog = response.json();
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
    });
    // The install has a value for the field — a presence-based validator
    // would consider it satisfied; the classifier must still re-prompt
    // because the value's storage bucket changed.
    await db
      .update(schema.mcpServersTable)
      .set({ environmentValues: { API_TOKEN: "stale-plain-value" } })
      .where(eq(schema.mcpServersTable.id, server.id));

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "reason-type-flip",
        serverType: "local",
        localConfig: {
          ...baseLocalConfig,
          environment: [
            {
              key: "API_TOKEN",
              type: "secret",
              sensitive: true,
              required: true,
              promptOnInstallation: true,
            },
          ],
        },
      },
    });
    expect(putResponse.statusCode).toBe(200);

    const serverRow = await getServerRow(server.id);
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.reinstallReason).toBe("new-input");
  });

  test("a re-prompt edit escalates an install pending a 'restart' from an earlier edit to 'new-input'", async ({
    makeMcpServer,
  }) => {
    const { catalogId, serverId } = await createCatalogWithInstall(
      makeMcpServer,
      "reason-escalates",
    );

    await db
      .update(schema.mcpServersTable)
      .set({ reinstallRequired: true, reinstallReason: "restart" })
      .where(eq(schema.mcpServersTable.id, serverId));

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: {
        name: "reason-escalates",
        serverType: "local",
        localConfig: {
          ...baseLocalConfig,
          environment: [
            {
              key: "NEW_REQUIRED_TOKEN",
              type: "secret",
              sensitive: true,
              required: true,
              promptOnInstallation: true,
            },
          ],
        },
        userConfig: { authorization: promptedAuthField },
      },
    });
    expect(putResponse.statusCode).toBe(200);

    const serverRow = await getServerRow(serverId);
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.reinstallReason).toBe("new-input");
  });

  test("an exec-only PUT never downgrades an install already owing input from an earlier edit", async ({
    makeMcpServer,
  }) => {
    const { catalogId, serverId } = await createCatalogWithInstall(
      makeMcpServer,
      "reason-no-downgrade",
    );

    // Simulate an earlier edit that left the install owing prompted input.
    await db
      .update(schema.mcpServersTable)
      .set({ reinstallRequired: true, reinstallReason: "new-input" })
      .where(eq(schema.mcpServersTable.id, serverId));

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalogId}`,
      payload: {
        name: "reason-no-downgrade",
        serverType: "local",
        localConfig: { ...baseLocalConfig, dockerImage: "example/image:4.0" },
        userConfig: { authorization: promptedAuthField },
      },
    });
    expect(putResponse.statusCode).toBe(200);

    const serverRow = await getServerRow(serverId);
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.reinstallReason).toBe("new-input");
  });
});
