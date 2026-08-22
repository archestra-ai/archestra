import { createMcpServerAlertFingerprint } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { InternalMcpCatalogModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    mcpServer: { alertingEnabled: true },
  }),
);

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("MCP catalog alert dismissal routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });
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

  test("dismisses and restores a catalog-level reinstall alert", async ({
    makeInternalMcpCatalog,
  }) => {
    const created = await makeInternalMcpCatalog({
      organizationId,
      name: "Shared documentation server",
      multitenant: true,
    });
    await InternalMcpCatalogModel.update(created.id, {
      catalogReinstallRequired: true,
    });
    const catalog = await InternalMcpCatalogModel.findById(created.id);
    if (!catalog) throw new Error("Catalog fixture disappeared");
    const fingerprint = createMcpServerAlertFingerprint({
      kind: "reinstall-required",
      catalogId: catalog.id,
      source: catalog.updatedAt,
    });

    const dismissed = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}/alert-mutes/reinstall-required`,
      payload: {
        issueFingerprint: fingerprint,
      },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({
      catalogId: catalog.id,
      mcpServerId: null,
      issueKind: "reinstall-required",
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
      url: `/api/internal_mcp_catalog/${catalog.id}/alert-mutes/reinstall-required?issueFingerprint=${encodeURIComponent(fingerprint)}`,
    });
    expect(restored.statusCode).toBe(200);
    expect(await db.select().from(schema.mcpServerAlertMutesTable)).toEqual([]);
    expect(await db.select().from(schema.auditLogsTable)).toEqual([]);
  });
});
