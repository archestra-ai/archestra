import { createMcpServerAlertFingerprint } from "@archestra/shared";
import { eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import McpServerModel from "@/models/mcp-server";
import McpServerAlertMuteModel from "@/models/mcp-server-alert-mute";
import { secretManager } from "@/secrets-manager";
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

const FAILED_AT = new Date("2026-08-01T10:00:00.000Z");
const REAUTH_FINGERPRINT = `v1:needs-reauth:${FAILED_AT.toISOString()}`;

const dismissBody = (reason: string) => ({
  issueFingerprint: REAUTH_FINGERPRINT,
  reason,
});
const restoreUrl = (serverId: string, fingerprint = REAUTH_FINGERPRINT) =>
  `/api/mcp_server/${serverId}/alert-mutes/needs-reauth?issueFingerprint=${encodeURIComponent(fingerprint)}`;

/**
 * Muting a connection's "needs re-authentication" alert. The rules under test
 * are the ones that keep a mute from hiding anything from anybody else: it is
 * scoped to one viewer, it only covers the one mutable kind, and it lapses the
 * moment a fresh refresh failure is recorded.
 */
describe("MCP server alert mute routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let catalogId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      vi.clearAllMocks();
      // A plain member: no installation-admin capability anywhere, so every
      // visibility decision below is the ordinary scope rule, not an admin
      // bypass.
      mockHasPermission.mockResolvedValue({
        success: false,
        error: new Error("Forbidden"),
      });

      user = await makeUser();
      organizationId = (await makeOrganization()).id;
      await makeMember(user.id, organizationId);
      catalogId = (await makeInternalMcpCatalog({ organizationId })).id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user, organizationId });
      });
      registerAuditLogHook(app);

      const { default: routes } = await import("./mcp-server");
      await app.register(routes);
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  /**
   * An org-scoped install (visible to every member) that is currently reporting
   * a terminal OAuth refresh failure — the state the alert is derived from.
   */
  async function makeAlertingServer(
    make: (overrides: Record<string, unknown>) => Promise<{ id: string }>,
    overrides: Record<string, unknown> = {},
  ) {
    const server = await make({
      catalogId,
      scope: "org",
      oauthRefreshError: "refresh_failed",
      ...overrides,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ oauthRefreshFailedAt: FAILED_AT })
      .where(eq(schema.mcpServersTable.id, server.id));
    return server;
  }

  async function listedServer(id: string) {
    const response = await app.inject({
      method: "GET",
      url: "/api/mcp_server",
    });
    expect(response.statusCode).toBe(200);
    return response
      .json()
      .find((server: { id: string }) => server.id === id) as {
      alertMutes: { issueKind: string; reason: string }[];
    };
  }

  test("mutes the alert for the caller without writing organization audit history", async ({
    makeMcpServer,
  }) => {
    const server = await makeAlertingServer(makeMcpServer, {
      name: "Jira (org)",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Owner is on leave until the 12th"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mcpServerId: server.id,
      issueKind: "needs-reauth",
      reason: "Owner is on leave until the 12th",
    });

    expect((await listedServer(server.id)).alertMutes).toEqual([
      expect.objectContaining({
        issueKind: "needs-reauth",
        reason: "Owner is on leave until the 12th",
      }),
    ]);

    expect(await db.select().from(schema.auditLogsTable)).toEqual([]);
  });

  test("accepts a live reinstall-required connection alert", async ({
    makeMcpServer,
  }) => {
    const created = await makeMcpServer({ catalogId, scope: "org" });
    const server = await McpServerModel.update(created.id, {
      reinstallRequired: true,
    });
    if (!server) throw new Error("MCP server fixture disappeared");
    const fingerprint = createMcpServerAlertFingerprint({
      kind: "reinstall-required",
      catalogId,
      serverId: server.id,
      source: server.updatedAt,
    });
    const response = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/reinstall-required`,
      payload: { issueFingerprint: fingerprint, reason: "Deferred" },
    });
    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(schema.mcpServerAlertMutesTable);
    expect(rows).toEqual([
      expect.objectContaining({
        issueKind: "reinstall-required",
        issueFingerprint: fingerprint,
      }),
    ]);
  });

  test("stores an opaque fingerprint without claiming the backend observed it", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer({ catalogId, scope: "org" });

    const response = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Pre-emptive"),
    });

    expect(response.statusCode).toBe(409);
  });

  test("accepts an omitted reason", async ({ makeMcpServer }) => {
    const server = await makeAlertingServer(makeMcpServer, {
      name: "Connection without note",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: { issueFingerprint: REAUTH_FINGERPRINT },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reason: "" });
    expect(await db.select().from(schema.auditLogsTable)).toEqual([]);
  });

  test("another user's mute does not hide the alert from me", async ({
    makeMcpServer,
    makeUser,
  }) => {
    const server = await makeAlertingServer(makeMcpServer);
    const otherUser = await makeUser();
    await McpServerAlertMuteModel.dismiss({
      userId: otherUser.id,
      catalogId,
      mcpServerId: server.id,
      issueKind: "needs-reauth",
      issueFingerprint: `v1:needs-reauth:${FAILED_AT.toISOString()}`,
      reason: "I know about this one",
    });

    expect((await listedServer(server.id)).alertMutes).toEqual([]);

    // And I cannot lift their mute either — the delete is keyed by viewer.
    const response = await app.inject({
      method: "DELETE",
      url: restoreUrl(server.id),
    });
    expect(response.statusCode).toBe(404);

    const rows = await db.select().from(schema.mcpServerAlertMutesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(otherUser.id);
  });

  test("re-dismissing replaces the failure fingerprint in place", async ({
    makeMcpServer,
  }) => {
    const server = await makeAlertingServer(makeMcpServer);
    await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Owner is on leave"),
    });
    expect((await listedServer(server.id)).alertMutes).toHaveLength(1);

    const rows = await db.select().from(schema.mcpServerAlertMutesTable);
    expect(rows).toHaveLength(1);

    const freshFingerprint = "v1:needs-reauth:2026-08-04T09:30:00.000Z";
    await db
      .update(schema.mcpServersTable)
      .set({ oauthRefreshFailedAt: new Date("2026-08-04T09:30:00.000Z") })
      .where(eq(schema.mcpServersTable.id, server.id));
    const remute = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: {
        issueFingerprint: freshFingerprint,
        reason: "Still on leave",
      },
    });
    expect(remute.statusCode).toBe(200);
    expect(
      await db.select().from(schema.mcpServerAlertMutesTable),
    ).toHaveLength(1);
    expect((await listedServer(server.id)).alertMutes).toEqual([
      expect.objectContaining({
        issueFingerprint: freshFingerprint,
        reason: "Still on leave",
      }),
    ]);
    const staleRestore = await app.inject({
      method: "DELETE",
      url: restoreUrl(server.id, REAUTH_FINGERPRINT),
    });
    expect(staleRestore.statusCode).toBe(404);
    expect((await listedServer(server.id)).alertMutes).toEqual([
      expect.objectContaining({ issueFingerprint: freshFingerprint }),
    ]);
  });

  test("unmuting brings the alert back without audit history and is not repeatable", async ({
    makeMcpServer,
  }) => {
    const server = await makeAlertingServer(makeMcpServer, { name: "Jira" });
    await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Owner is on leave"),
    });

    const response = await app.inject({
      method: "DELETE",
      url: restoreUrl(server.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    expect((await listedServer(server.id)).alertMutes).toEqual([]);
    expect(await db.select().from(schema.mcpServerAlertMutesTable)).toEqual([]);

    expect(await db.select().from(schema.auditLogsTable)).toEqual([]);

    const again = await app.inject({
      method: "DELETE",
      url: restoreUrl(server.id),
    });
    expect(again.statusCode).toBe(404);
  });

  test("cannot mute or unmute an alert on a connection the caller cannot see", async ({
    makeMcpServer,
    makeUser,
  }) => {
    const otherUser = await makeUser();
    const server = await makeAlertingServer(makeMcpServer, {
      scope: "personal",
      ownerId: otherUser.id,
    });

    const muteResponse = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Not mine to see"),
    });
    expect(muteResponse.statusCode).toBe(404);

    const unmuteResponse = await app.inject({
      method: "DELETE",
      url: restoreUrl(server.id),
    });
    expect(unmuteResponse.statusCode).toBe(404);

    expect(await db.select().from(schema.mcpServerAlertMutesTable)).toEqual([]);
  });

  test("cannot dismiss an organization-scoped connection from another organization", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const otherCatalog = await makeInternalMcpCatalog({
      organizationId: otherOrganization.id,
    });
    const server = await makeAlertingServer(makeMcpServer, {
      catalogId: otherCatalog.id,
      scope: "org",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Not in this organization"),
    });

    expect(response.statusCode).toBe(404);
    expect(await db.select().from(schema.mcpServerAlertMutesTable)).toEqual([]);
  });

  /**
   * The pin is only a usable key because `oauthRefreshFailedAt` marks the START
   * of a failure, not the last attempt at one. A dead credential is re-observed
   * on every tool call, so a last-attempt clock would lapse every mute within
   * seconds of it being taken and the Mute button would appear to do nothing.
   */
  test("re-observing the same fault leaves the pin, and the mute, alone", async ({
    makeMcpServer,
  }) => {
    const server = await makeAlertingServer(makeMcpServer);
    await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Owner is on leave"),
    });
    expect((await listedServer(server.id)).alertMutes).toHaveLength(1);

    // The connection is used again while the credential is still dead: the
    // same fault is reported once more, with a fresher cause.
    await McpServerModel.recordOAuthRefreshFailure(server.id, {
      oauthRefreshError: "refresh_failed",
      oauthRefreshErrorMessage: "invalid_grant",
      oauthRefreshErrorDescription: "The refresh token is invalid",
      oauthRefreshFailedAt: new Date("2026-08-04T09:30:00.000Z"),
    });

    const row = await McpServerModel.findById(server.id);
    expect(row?.oauthRefreshFailedAt?.getTime()).toBe(FAILED_AT.getTime());
    // The cause fields still carry the latest diagnosis — only the stamp is
    // held back.
    expect(row?.oauthRefreshErrorMessage).toBe("invalid_grant");
    expect(row?.oauthRefreshErrorDescription).toBe(
      "The refresh token is invalid",
    );

    expect((await listedServer(server.id)).alertMutes).toEqual([
      expect.objectContaining({ reason: "Owner is on leave" }),
    ]);
  });

  test("re-authenticating clears the fault and deletes the mute, so a later fault is not born muted", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const oauthCatalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      oauthConfig: {
        name: "reauth-drops-mutes",
        server_url: "https://mcp.example.com/mcp",
        client_id: "test-client-id",
        redirect_uris: ["http://localhost:3000/callback"],
        scopes: [],
        default_scopes: [],
        supports_resource_metadata: false,
      },
    });
    const server = await makeAlertingServer(makeMcpServer, {
      catalogId: oauthCatalog.id,
      serverType: "remote",
    });

    await app.inject({
      method: "PUT",
      url: `/api/mcp_server/${server.id}/alert-mutes/needs-reauth`,
      payload: dismissBody("Owner is on leave"),
    });
    expect((await listedServer(server.id)).alertMutes).toHaveLength(1);

    // Re-authentication is one of the two places the fault is cleared. The
    // route needs the install-create capability the rest of this suite denies.
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    const newSecret = await secretManager().createSecret(
      { access_token: "fresh", refresh_token: "fresh-refresh" },
      "alert-mute-reauth-secret",
    );
    const reauth = await app.inject({
      method: "PATCH",
      url: `/api/mcp_server/${server.id}/reauthenticate`,
      payload: { secretId: newSecret.id },
    });
    expect(reauth.statusCode).toBe(200);

    // The episode is over, so the row is gone rather than left behind for a
    // later fault to inherit.
    expect(await db.select().from(schema.mcpServerAlertMutesTable)).toEqual([]);

    // A genuinely new fault therefore surfaces to the person who silenced the
    // previous one.
    await McpServerModel.recordOAuthRefreshFailure(server.id, {
      oauthRefreshError: "refresh_failed",
      oauthRefreshErrorMessage: "invalid_grant",
      oauthRefreshErrorDescription: null,
      oauthRefreshFailedAt: new Date("2026-08-09T14:00:00.000Z"),
    });

    const row = await McpServerModel.findById(server.id);
    expect(row?.oauthRefreshFailedAt?.getTime()).toBe(
      new Date("2026-08-09T14:00:00.000Z").getTime(),
    );
    expect((await listedServer(server.id)).alertMutes).toEqual([]);
  });

  test("mute and unmute are gated on installation read in the endpoint permission map", async () => {
    const { requiredEndpointPermissionsMap } = await import(
      "@archestra/shared/access-control"
    );
    expect(requiredEndpointPermissionsMap.muteMcpServerAlert).toEqual({
      mcpServerInstallation: ["read"],
    });
    expect(requiredEndpointPermissionsMap.unmuteMcpServerAlert).toEqual({
      mcpServerInstallation: ["read"],
    });
  });
});
