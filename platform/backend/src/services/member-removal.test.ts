import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  InvitationModel,
  MemberModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { removeMemberTarget } from "./member-removal";

describe("removeMemberTarget", () => {
  test("removes private agents for a departing member while retaining shared and other-organization agents", async ({
    makeAccount,
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const owner = await makeUser();
    const recipient = await makeUser();
    await makeMember(owner.id, organization.id);
    await makeMember(owner.id, otherOrganization.id);
    await makeMember(recipient.id, organization.id);
    await makeAccount(owner.id);
    const privateAgent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
      name: "Renamed assistant",
      access: "personal",
    });
    const sharedAgent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
      access: { users: [recipient.id] },
    });
    const otherAgent = await makeAgent({
      organizationId: otherOrganization.id,
      authorId: owner.id,
      agentType: "agent",
      access: "personal",
    });

    const member = await MemberModel.getByUserId(owner.id, organization.id);
    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        target: { kind: "member", id: member?.id ?? "" },
      }),
    ).resolves.toEqual({ status: "removed" });

    const rows = await db
      .select({
        id: schema.agentsTable.id,
        deletedAt: schema.agentsTable.deletedAt,
      })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.authorId, owner.id));
    expect(
      rows.find((row) => row.id === privateAgent.id)?.deletedAt,
    ).not.toBeNull();
    expect(rows.find((row) => row.id === sharedAgent.id)?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === otherAgent.id)?.deletedAt).toBeNull();
  });

  test("withdraws only this organization's pending invitation and retains a user with another membership", async ({
    makeInvitation,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const actor = await makeUser();
    const pendingUser = await makeUser({ email: "pending@example.com" });
    await makeMember(pendingUser.id, organization.id);
    await makeMember(pendingUser.id, otherOrganization.id);
    const invitation = await makeInvitation(organization.id, actor.id, {
      email: pendingUser.email,
      status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
    });
    const otherInvitation = await makeInvitation(
      otherOrganization.id,
      actor.id,
      {
        email: pendingUser.email,
        status: `${AUTO_PROVISIONED_INVITATION_STATUS}:slack`,
      },
    );

    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: actor.id,
        target: { kind: "pendingSignup", id: pendingUser.id },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect(
      await MemberModel.getByUserId(pendingUser.id, organization.id),
    ).toBeUndefined();
    expect(
      await MemberModel.getByUserId(pendingUser.id, otherOrganization.id),
    ).toBeDefined();
    expect(await InvitationModel.getById(invitation.id)).toBeUndefined();
    expect(await InvitationModel.getById(otherInvitation.id)).toBeDefined();
    expect(await UserModel.getById(pendingUser.id)).toBeDefined();
  });

  test("runs accepted-member cleanup after removing a last membership", async ({
    makeAgent,
    makeAccount,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const actor = await makeUser();
    const acceptedUser = await makeUser();
    const member = await makeMember(acceptedUser.id, organization.id);
    const duplicate = await makeMember(acceptedUser.id, organization.id);
    await makeAccount(acceptedUser.id);
    const personalAgent = await makeAgent({
      organizationId: organization.id,
      authorId: acceptedUser.id,
      agentType: "agent",
      access: "personal",
    });

    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: actor.id,
        target: { kind: "member", id: member.id },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect(await MemberModel.getById(member.id)).toBeUndefined();
    expect(await MemberModel.getById(duplicate.id)).toBeUndefined();
    expect(await UserModel.getById(acceptedUser.id)).toBeUndefined();
    const [agent] = await db
      .select({ deletedAt: schema.agentsTable.deletedAt })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, personalAgent.id));
    expect(agent.deletedAt).not.toBeNull();
  });

  test("revokes only the removed organization's token for a multi-org member", async ({
    makeAccount,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const actor = await makeUser();
    const acceptedUser = await makeUser();
    const member = await makeMember(acceptedUser.id, organization.id);
    await makeMember(acceptedUser.id, otherOrganization.id);
    await makeAccount(acceptedUser.id);
    await UserTokenModel.create(acceptedUser.id, organization.id);
    await UserTokenModel.create(acceptedUser.id, otherOrganization.id);

    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: actor.id,
        target: { kind: "member", id: member.id },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect(
      await UserTokenModel.findByUserAndOrg(acceptedUser.id, organization.id),
    ).toBeNull();
    expect(
      await UserTokenModel.findByUserAndOrg(
        acceptedUser.id,
        otherOrganization.id,
      ),
    ).toBeDefined();
    expect(await UserModel.getById(acceptedUser.id)).toBeDefined();
  });
});
