import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  AgentModel,
  InternalMcpCatalogModel,
  MemberModel,
  OrganizationModel,
  SkillModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { removeMemberTarget } from "./member-removal";

describe("handing off a departing member's shared resources", () => {
  test("an admin who removes a member becomes the owner of everything the member shared, and personal items are still deleted", async ({
    makeAccount,
    makeInternalAgent,
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeSkill,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const admin = await makeUser();
    const departing = await makeUser();
    await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
    await makeMember(departing.id, organization.id);
    await makeAccount(departing.id);
    const team = await makeTeam(organization.id, admin.id);

    const teamAgent = await makeInternalAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: { teams: [team.id] },
    });
    const personalAgent = await makeInternalAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: "personal",
    });
    const teamSkill = await makeSkill(organization.id, {
      authorId: departing.id,
      access: { teams: [team.id] },
    });
    const orgCatalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      authorId: departing.id,
      access: "org",
    });

    const member = await MemberModel.getByUserId(departing.id, organization.id);
    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        actorUserId: admin.id,
        target: { kind: "member", id: member?.id ?? "" },
      }),
    ).resolves.toEqual({ status: "removed" });

    expect((await AgentModel.findById(teamAgent.id))?.authorId).toBe(admin.id);
    expect((await SkillModel.findById(teamSkill.id))?.authorId).toBe(admin.id);
    expect(
      (
        await InternalMcpCatalogModel.findById(orgCatalog.id, {
          organizationId: organization.id,
          expandSecrets: false,
        })
      )?.authorId,
    ).toBe(admin.id);
    const [personalRow] = await db
      .select({ deletedAt: schema.agentsTable.deletedAt })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, personalAgent.id));
    expect(personalRow?.deletedAt).not.toBeNull();

    // The new owner holds the creator's grant, so they can manage the agent.
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: organization.id,
      resource: "agent",
      scope: teamAgent.id,
    });
    expect(
      policy?.grants.find(
        (grant) =>
          grant.subject.type === "user" && grant.subject.id === admin.id,
      )?.actions,
    ).toContain("manage-permissions");

    const [audit] = await db
      .select()
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.resourceId, teamAgent.id),
          eq(schema.auditLogsTable.action, "agent.updated"),
        ),
      );
    expect(audit).toMatchObject({
      actorId: admin.id,
      actorType: "user",
      before: { authorId: departing.id },
      after: { authorId: admin.id },
    });
  });

  test("without a named recipient (a member leaving on their own), an admin receives the shared resources", async ({
    makeAccount,
    makeInternalAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const admin = await makeUser();
    const departing = await makeUser();
    await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
    await makeMember(departing.id, organization.id);
    await makeAccount(departing.id);
    const team = await makeTeam(organization.id, admin.id);
    const teamAgent = await makeInternalAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: { teams: [team.id] },
    });

    const member = await MemberModel.getByUserId(departing.id, organization.id);
    await removeMemberTarget({
      organizationId: organization.id,
      target: { kind: "member", id: member?.id ?? "" },
    });

    expect((await AgentModel.findById(teamAgent.id))?.authorId).toBe(admin.id);
  });

  test("with no admin left, removal still succeeds and shared resources survive without being handed to a non-admin", async ({
    makeAccount,
    makeInternalAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const colleague = await makeUser();
    const departing = await makeUser();
    await makeMember(colleague.id, organization.id);
    await makeMember(departing.id, organization.id, { role: ADMIN_ROLE_NAME });
    await makeAccount(departing.id);
    const sharedAgent = await makeInternalAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: { users: [colleague.id] },
    });

    const member = await MemberModel.getByUserId(departing.id, organization.id);
    await expect(
      removeMemberTarget({
        organizationId: organization.id,
        target: { kind: "member", id: member?.id ?? "" },
      }),
    ).resolves.toEqual({ status: "removed" });

    // Nobody can take over, so nothing moves; deleting the departing user's
    // account then clears the owner, but the agent itself is kept.
    const agent = await AgentModel.findById(sharedAgent.id);
    expect(agent).not.toBeNull();
    expect(agent?.authorId).not.toBe(colleague.id);
  });
  test("without a named recipient, the organization's configured new owner receives the shared resources", async ({
    makeAccount,
    makeInternalAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const admin = await makeUser();
    const configuredOwner = await makeUser();
    const departing = await makeUser();
    await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
    await makeMember(configuredOwner.id, organization.id);
    await makeMember(departing.id, organization.id);
    await makeAccount(departing.id);
    await OrganizationModel.patch(organization.id, {
      departingMemberOwnerId: configuredOwner.id,
    });
    const team = await makeTeam(organization.id, admin.id);
    const teamAgent = await makeInternalAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: { teams: [team.id] },
    });

    const member = await MemberModel.getByUserId(departing.id, organization.id);
    await removeMemberTarget({
      organizationId: organization.id,
      target: { kind: "member", id: member?.id ?? "" },
    });

    expect((await AgentModel.findById(teamAgent.id))?.authorId).toBe(
      configuredOwner.id,
    );
  });

  test("when the configured new owner is the one leaving, the longest-standing admin receives the shared resources", async ({
    makeAccount,
    makeInternalAgent,
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const admin = await makeUser();
    const departing = await makeUser();
    await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
    await makeMember(departing.id, organization.id);
    await makeAccount(departing.id);
    await OrganizationModel.patch(organization.id, {
      departingMemberOwnerId: departing.id,
    });
    const team = await makeTeam(organization.id, admin.id);
    const teamAgent = await makeInternalAgent({
      organizationId: organization.id,
      authorId: departing.id,
      access: { teams: [team.id] },
    });

    const member = await MemberModel.getByUserId(departing.id, organization.id);
    await removeMemberTarget({
      organizationId: organization.id,
      target: { kind: "member", id: member?.id ?? "" },
    });

    expect((await AgentModel.findById(teamAgent.id))?.authorId).toBe(admin.id);
  });
});
