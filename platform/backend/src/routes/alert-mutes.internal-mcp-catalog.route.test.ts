import {
  createMcpServerAlertFingerprint,
  mcpRuntimeAlertSource,
} from "@archestra/shared";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import config from "@/config";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("MCP catalog alert dismissal routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.mcpServer.alertingEnabled = true;
    // A plain member: permission checks read the member role.
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("dismisses and restores a catalog-level runtime alert", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const created = await makeInternalMcpCatalog({
      organizationId,
      name: "Shared documentation server",
      multitenant: true,
    });
    const installationError = "Container failed before discovery";
    const server = await makeMcpServer({
      catalogId: created.id,
      scope: "org",
    });
    await McpServerModel.update(server.id, {
      localInstallationStatus: "error",
      localInstallationError: installationError,
    });
    const catalog = await InternalMcpCatalogModel.findById(created.id);
    if (!catalog) throw new Error("Catalog fixture disappeared");
    const fingerprint = createMcpServerAlertFingerprint({
      kind: "failed-to-start",
      catalogId: catalog.id,
      source: mcpRuntimeAlertSource({
        serverId: `catalog:${catalog.id}`,
        deploymentName: catalog.id,
        state: "failed",
        error: JSON.stringify([installationError]),
      }),
    });

    const dismissed = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}/alert-mutes/failed-to-start`,
      payload: {
        issueFingerprint: fingerprint,
      },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({
      catalogId: catalog.id,
      mcpServerId: null,
      issueKind: "failed-to-start",
      issueFingerprint: fingerprint,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog",
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().find((item: { id: string }) => item.id === catalog.id)
        ?.alertMutes,
    ).toEqual([
      expect.objectContaining({
        issueFingerprint: fingerprint,
        reason: "",
      }),
    ]);

    expect(await db.select().from(schema.auditLogsTable)).toEqual([]);

    const restored = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${catalog.id}/alert-mutes/failed-to-start?issueFingerprint=${encodeURIComponent(fingerprint)}`,
    });
    expect(restored.statusCode).toBe(200);
    expect(await db.select().from(schema.mcpServerAlertMutesTable)).toEqual([]);
    expect(await db.select().from(schema.auditLogsTable)).toEqual([]);
  });
});
