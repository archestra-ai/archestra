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
