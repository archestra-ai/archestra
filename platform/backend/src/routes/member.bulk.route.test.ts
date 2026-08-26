import {
  ADMIN_ROLE_NAME,
  AUTO_PROVISIONED_INVITATION_STATUS,
  MAX_BULK_IDS,
  RouteId,
} from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { MemberModel, UserModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import memberRoutes from "./member";

describe("DELETE /api/members/bulk", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(
    async ({ makeAccount, makeAdmin, makeMember, makeOrganization }) => {
      organizationId = (await makeOrganization()).id;
      user = await makeAdmin();
      await makeAccount(user.id);
      await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { organizationId, user });
      });
      registerAuditLogHook(app);
      await app.register(memberRoutes);
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const bulkDelete = (targets: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/members/bulk",
      payload: { targets },
    });

  test("removes a mixed deduplicated batch and does not disclose foreign or missing targets", async ({
    makeAccount,
    makeInvitation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const acceptedUser = await makeUser();
    const acceptedMember = await makeMember(acceptedUser.id, organizationId);
    await makeAccount(acceptedUser.id);
    const pendingUser = await makeUser({ email: "pending@example.com" });
    await makeMember(pendingUser.id, organizationId);
    await makeInvitation(organizationId, user.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });

    const foreignOrganization = await makeOrganization();
    const foreignUser = await makeUser();
    const foreignMember = await makeMember(
      foreignUser.id,
      foreignOrganization.id,
    );
    await makeAccount(foreignUser.id);
    const missing = crypto.randomUUID();

    const response = await bulkDelete([
      { kind: "member", id: acceptedMember.id },
      { kind: "member", id: acceptedMember.id },
      { kind: "pendingSignup", id: pendingUser.id },
      { kind: "member", id: foreignMember.id },
      { kind: "pendingSignup", id: missing },
    ]);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { kind: "member", id: acceptedMember.id },
        { kind: "pendingSignup", id: pendingUser.id },
      ],
      failed: [
        { kind: "member", id: foreignMember.id, error: "Member not found" },
        { kind: "pendingSignup", id: missing, error: "Member not found" },
      ],
    });
    expect(await MemberModel.getById(acceptedMember.id)).toBeUndefined();
    expect(await UserModel.getById(pendingUser.id)).toBeUndefined();
    expect(await MemberModel.getById(foreignMember.id)).toBeDefined();
  });

  test("guards self-removal and rechecks each target's accepted status", async ({
    makeMember,
    makeUser,
  }) => {
    const pendingUser = await makeUser();
    await makeMember(pendingUser.id, organizationId);

    const response = await bulkDelete([
      { kind: "member", id: await currentMemberId() },
      { kind: "member", id: await pendingMemberId(pendingUser.id) },
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [],
      failed: [
        {
          kind: "member",
          id: await currentMemberId(),
          error: "You cannot remove your own account",
        },
        {
          kind: "member",
          id: await pendingMemberId(pendingUser.id),
          error: "Member signup status changed",
        },
      ],
    });
    expect(await UserModel.getById(user.id)).toBeDefined();
  });

  test("validates the batch cap and writes one safe audit record only when rows change", async ({
    makeAccount,
    makeMember,
    makeUser,
  }) => {
    const acceptedUser = await makeUser();
    const member = await makeMember(acceptedUser.id, organizationId);
    await makeAccount(acceptedUser.id);

    expect((await bulkDelete([])).statusCode).toBe(400);
    expect(
      (
        await bulkDelete(
          Array.from({ length: MAX_BULK_IDS + 1 }, () => ({
            kind: "member",
            id: crypto.randomUUID(),
          })),
        )
      ).statusCode,
    ).toBe(400);

    expect(
      (await bulkDelete([{ kind: "member", id: crypto.randomUUID() }]))
        .statusCode,
    ).toBe(200);
    expect(await auditRows()).toEqual([]);

    expect(
      (await bulkDelete([{ kind: "member", id: member.id }])).statusCode,
    ).toBe(200);
    expect(await auditRows()).toEqual([
      {
        before: { members: [{ kind: "member", id: member.id }] },
        after: { members: [] },
      },
    ]);
  });

  test("requires member delete permission", () => {
    expect(requiredEndpointPermissionsMap[RouteId.BulkDeleteMembers]).toEqual({
      member: ["delete"],
    });
  });

  async function currentMemberId() {
    return (await MemberModel.getByUserId(user.id, organizationId))?.id ?? "";
  }

  async function pendingMemberId(userId: string) {
    return (await MemberModel.getByUserId(userId, organizationId))?.id ?? "";
  }

  async function auditRows() {
    return db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "member.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );
  }
});
