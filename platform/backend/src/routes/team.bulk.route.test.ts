import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { TeamModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

describe("DELETE /api/teams/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);

    const { default: teamRoutes } = await import("./team");
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({ method: "DELETE", url: "/api/teams/bulk", payload: { ids } });

  test("deletes every named team and leaves the rest alone", async ({
    makeTeam,
  }) => {
    const first = await makeTeam(organizationId, user.id, { name: "Alpha" });
    const second = await makeTeam(organizationId, user.id, { name: "Beta" });
    const kept = await makeTeam(organizationId, user.id, { name: "Gamma" });

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "Alpha" },
        { id: second.id, name: "Beta" },
      ],
      failed: [],
    });
    expect(await TeamModel.findById(first.id)).toBeNull();
    expect(await TeamModel.findById(kept.id)).not.toBeNull();
  });

  test("reports a team from another organization as not found and leaves it standing", async ({
    makeTeam,
    makeOrganization,
    makeUser,
  }) => {
    const mine = await makeTeam(organizationId, user.id, { name: "Mine" });
    const otherOrgId = (await makeOrganization()).id;
    const stranger = await makeUser();
    const foreign = await makeTeam(otherOrgId, stranger.id, {
      name: "Theirs",
    });

    const response = await bulkDelete([mine.id, foreign.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: mine.id, name: "Mine" }],
      failed: [{ id: foreign.id, name: null, error: "Team not found" }],
    });
    expect(await TeamModel.findById(foreign.id)).not.toBeNull();
  });

  /**
   * Deleting teams is one organization-wide permission, the same for every id,
   * so an unauthorized caller is refused up front rather than told individually
   * about each team they could not remove.
   */
  test("refuses the whole batch when the caller cannot delete teams", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, user.id, { name: "Safe" });
    mockHasPermission.mockResolvedValue({ success: false, error: null });

    const response = await bulkDelete([team.id]);

    expect(response.statusCode).toBe(403);
    expect(await TeamModel.findById(team.id)).not.toBeNull();
  });

  test("collapses duplicate ids", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, user.id, { name: "Dupe" });

    const response = await bulkDelete([team.id, team.id]);

    expect(response.json().succeeded).toEqual([{ id: team.id, name: "Dupe" }]);
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, user.id, {
      name: "Audited Team",
    });

    expect((await bulkDelete([team.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "team.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("team");
    expect(rows[0].before).toMatchObject({
      teams: [{ id: team.id, name: "Audited Team" }],
    });
    expect(rows[0].after).toMatchObject({ teams: [] });
  });
});
