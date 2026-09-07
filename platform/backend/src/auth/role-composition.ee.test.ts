import { createHmac } from "node:crypto";
import { auth } from "@/auth/better-auth";
import { MemberModel, TeamModel } from "@/models";
import { expect, test } from "@/test";

test("native member updates honor inherited roles without storing them as direct assignments", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeSession,
}) => {
  const org = await makeOrganization();
  const caller = await makeUser();
  const target = await makeUser();
  const role = await makeCustomRole(org.id, {
    role: "member_manager",
    permission: { member: ["update"], log: ["read"], invitation: ["create"] },
  });
  const reader = await makeCustomRole(org.id, {
    role: "log_reader",
    permission: { log: ["read"] },
  });
  await makeMember(caller.id, org.id, { role: "member" });
  const targetMember = await makeMember(target.id, org.id, { role: "member" });
  const team = await TeamModel.create({
    name: "User administrators",
    organizationId: org.id,
    createdBy: caller.id,
    roles: [role.role],
  });
  const session = await makeSession(caller.id, {
    activeOrganizationId: org.id,
  });
  const context = await auth.$context;
  const signature = createHmac("sha256", context.secret)
    .update(session.token)
    .digest("base64");
  const headers = new Headers({
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
  });
  await auth.api.updateMemberRole({
    headers,
    body: {
      organizationId: org.id,
      memberId: targetMember.id,
      role: reader.role,
    },
  });
  expect((await MemberModel.getByUserId(target.id, org.id))?.role).toBe(
    reader.role,
  );
  expect((await MemberModel.getByUserId(caller.id, org.id))?.role).toBe(
    "member",
  );
  const invited = await makeUser({ email: "invited@example.com" });
  const invitation = await auth.api.createInvitation({
    headers,
    body: {
      organizationId: org.id,
      email: invited.email,
      role: ["member", reader.role],
    },
  });
  const invitedSession = await makeSession(invited.id, {
    activeOrganizationId: org.id,
  });
  const invitedSignature = createHmac("sha256", context.secret)
    .update(invitedSession.token)
    .digest("base64");
  const invitedHeaders = new Headers({
    cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${invitedSession.token}.${invitedSignature}`)}`,
  });
  await auth.api.acceptInvitation({
    headers: invitedHeaders,
    body: { invitationId: invitation.id },
  });
  expect(
    (await MemberModel.getByUserId(invited.id, org.id))?.role.split(",").sort(),
  ).toEqual(["log_reader", "member"]);
  await TeamModel.update(team.id, { roles: [] });
  await expect(
    auth.api.updateMemberRole({
      headers,
      body: {
        organizationId: org.id,
        memberId: targetMember.id,
        role: reader.role,
      },
    }),
  ).rejects.toThrow();
});
