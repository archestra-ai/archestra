import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import { autoProvisionUser } from "@/agents/chatops/auto-provision";
import db, { schema } from "@/database";
import ChatOpsUserAdmissionModel from "@/models/chatops-user-admission";
import UserModel from "@/models/user";
import organizationRoutes from "@/routes/organization";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";

describe("DELETE /api/organization/members/:userId/pending-signup", () => {
  const ctx = useRouteTestApp(organizationRoutes);

  test("explicit pending-user removal also removes an outstanding Teams admission", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const pending = await autoProvisionUser({
      email: "pending@example.com",
      name: "Pending",
      provider: "ms-teams",
    });
    const admission = await ChatOpsUserAdmissionModel.acquire(
      "pending@example.com",
    );
    expect(admission?.admissionId).toBeTruthy();
    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/organization/members/${pending.userId}/pending-signup`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await UserModel.getById(pending.userId)).toBeUndefined();
    expect(
      await db.select().from(schema.chatopsUserAdmissionsTable),
    ).toHaveLength(0);
  });
});

describe("GET /api/organization/members/signup-status", () => {
  const ctx = useRouteTestApp(organizationRoutes);

  test("lists the members without an account, with their invitation, in one statement", async ({
    makeUser,
    makeMember,
    makeAccount,
    makeInvitation,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    await makeAccount(ctx.user.id);
    const signedUp = await makeUser();
    await makeMember(signedUp.id, ctx.organizationId);
    await makeAccount(signedUp.id);
    const provisioned = await makeUser({ email: "provisioned@example.com" });
    await makeMember(provisioned.id, ctx.organizationId);
    await makeInvitation(ctx.organizationId, ctx.user.id, {
      email: provisioned.email,
      status: "auto-provisioned:ms-teams",
    });
    const invited = await makeInvitation(ctx.organizationId, ctx.user.id, {
      email: provisioned.email,
      status: "auto-provisioned:slack",
    });
    const noInvitation = await makeUser();
    await makeMember(noInvitation.id, ctx.organizationId);

    const query = vi.spyOn(PGlite.prototype, "query");
    let response: Awaited<ReturnType<typeof ctx.app.inject>>;
    try {
      response = await ctx.app.inject({
        method: "GET",
        url: "/api/organization/members/signup-status",
      });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }

    expect(response.statusCode, response.body).toBe(200);
    const pending = response.json().pendingSignupMembers as Array<{
      userId: string;
      provider: string | null;
      invitationId: string | null;
    }>;
    expect(pending.map((member) => member.userId).sort()).toEqual(
      [provisioned.id, noInvitation.id].sort(),
    );
    // The newest auto-provisioned invitation wins.
    expect(pending.find((m) => m.userId === provisioned.id)).toMatchObject({
      provider: "slack",
      invitationId: invited.id,
    });
    expect(pending.find((m) => m.userId === noInvitation.id)).toMatchObject({
      provider: null,
      invitationId: null,
    });
  });

  test("answers only for the members on screen when userIds is given", async ({
    makeUser,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const onScreen = await makeUser();
    await makeMember(onScreen.id, ctx.organizationId);
    const elsewhere = await makeUser();
    await makeMember(elsewhere.id, ctx.organizationId);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/organization/members/signup-status?userIds=${onScreen.id},${ctx.user.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .pendingSignupMembers.map((member: { userId: string }) => member.userId)
        .sort(),
    ).toEqual([ctx.user.id, onScreen.id].sort());
  });
});
