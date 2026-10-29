import { vi } from "vitest";
import TeamModel from "@/models/team";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  canManageTeamMembers,
  canReadTeam,
  checkLastAdminInvariant,
  cleanupCredentialSourcesAfterMemberRemoval,
  getTeamForOrg,
} from "./team-authorization";

describe("team-authorization service", () => {
  let organizationId: string;
  let creatorId: string;

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const creator = await makeUser();
    creatorId = creator.id;
    await makeMember(creator.id, org.id, { role: "admin" });
  });

  describe("getTeamForOrg", () => {
    test("returns the team when it belongs to the org", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, creatorId, { name: "T" });
      const result = await getTeamForOrg({ teamId: team.id, organizationId });
      expect(result?.id).toBe(team.id);
    });

    test("returns the team without its members unless asked", async ({
      makeTeam,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      await makeTeamMember(team.id, creatorId);

      const row = await getTeamForOrg({ teamId: team.id, organizationId });
      expect(row).not.toHaveProperty("members");
      const withMembers = await getTeamForOrg({
        teamId: team.id,
        organizationId,
        includeMembers: true,
      });
      expect(withMembers?.members).toHaveLength(1);
    });

    test("returns null for a team in another org", async ({
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const otherOrg = await makeOrganization();
      const otherUser = await makeUser();
      const team = await makeTeam(otherOrg.id, otherUser.id);
      const result = await getTeamForOrg({ teamId: team.id, organizationId });
      expect(result).toBeNull();
    });

    test("returns null for a missing team", async () => {
      const result = await getTeamForOrg({
        teamId: crypto.randomUUID(),
        organizationId,
      });
      expect(result).toBeNull();
    });
  });

  describe("canManageTeamMembers", () => {
    test("an org team manager can manage any team", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, creatorId);
      const result = await canManageTeamMembers({
        isOrgTeamManager: true,
        userId: creatorId,
        teamId: team.id,
      });
      expect(result).toBe(true);
    });

    test("a team admin can manage their team", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, user.id, { role: "admin" });
      const result = await canManageTeamMembers({
        isOrgTeamManager: false,
        userId: user.id,
        teamId: team.id,
      });
      expect(result).toBe(true);
    });

    test("a plain team member cannot manage the team", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, user.id, { role: "member" });
      const result = await canManageTeamMembers({
        isOrgTeamManager: false,
        userId: user.id,
        teamId: team.id,
      });
      expect(result).toBe(false);
    });
  });

  describe("canReadTeam", () => {
    test("an org team manager can read any team", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, creatorId);
      const result = await canReadTeam({
        isOrgTeamManager: true,
        userId: creatorId,
        teamId: team.id,
      });
      expect(result).toBe(true);
    });

    test("a team member can read their team", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, user.id, { role: "member" });
      const result = await canReadTeam({
        isOrgTeamManager: false,
        userId: user.id,
        teamId: team.id,
      });
      expect(result).toBe(true);
    });

    test("a non-member cannot read the team", async ({
      makeTeam,
      makeUser,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const outsider = await makeUser();
      const result = await canReadTeam({
        isOrgTeamManager: false,
        userId: outsider.id,
        teamId: team.id,
      });
      expect(result).toBe(false);
    });
  });

  describe("checkLastAdminInvariant", () => {
    test("member_not_found when the target isn't on the team", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const result = await checkLastAdminInvariant({
        teamId: team.id,
        userId: crypto.randomUUID(),
        nextRole: "member",
      });
      expect(result).toEqual({ ok: false, reason: "member_not_found" });
    });

    test("ok when demoting a non-admin member", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, user.id, { role: "member" });
      const result = await checkLastAdminInvariant({
        teamId: team.id,
        userId: user.id,
        nextRole: null,
      });
      expect(result).toEqual({ ok: true });
    });

    test("last_admin when the sole admin would be demoted", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const admin = await makeUser();
      await makeMember(admin.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, admin.id, { role: "admin" });
      const result = await checkLastAdminInvariant({
        teamId: team.id,
        userId: admin.id,
        nextRole: "member",
      });
      expect(result).toEqual({ ok: false, reason: "last_admin" });
    });

    test("ok when another admin remains", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const adminA = await makeUser();
      const adminB = await makeUser();
      await makeMember(adminA.id, organizationId, { role: "member" });
      await makeMember(adminB.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, adminA.id, { role: "admin" });
      await makeTeamMember(team.id, adminB.id, { role: "admin" });
      const result = await checkLastAdminInvariant({
        teamId: team.id,
        userId: adminA.id,
        nextRole: null,
      });
      expect(result).toEqual({ ok: true });
    });

    test("ok when the sole admin keeps the admin role", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const admin = await makeUser();
      await makeMember(admin.id, organizationId, { role: "member" });
      await makeTeamMember(team.id, admin.id, { role: "admin" });
      const result = await checkLastAdminInvariant({
        teamId: team.id,
        userId: admin.id,
        nextRole: "admin",
      });
      expect(result).toEqual({ ok: true });
    });

    test("counts admins without loading the member list", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const soloTeam = await makeTeam(organizationId, creatorId);
      const pairTeam = await makeTeam(organizationId, creatorId);
      const adminA = await makeUser();
      const adminB = await makeUser();
      await makeMember(adminA.id, organizationId, { role: "member" });
      await makeMember(adminB.id, organizationId, { role: "member" });
      await makeTeamMember(soloTeam.id, adminA.id, { role: "admin" });
      await makeTeamMember(pairTeam.id, adminA.id, { role: "admin" });
      await makeTeamMember(pairTeam.id, adminB.id, { role: "admin" });
      const loadMembers = vi.spyOn(TeamModel, "getTeamMembers");

      expect(
        await checkLastAdminInvariant({
          teamId: soloTeam.id,
          userId: adminA.id,
          nextRole: "member",
        }),
      ).toEqual({ ok: false, reason: "last_admin" });
      expect(
        await checkLastAdminInvariant({
          teamId: pairTeam.id,
          userId: adminA.id,
          nextRole: null,
        }),
      ).toEqual({ ok: true });
      expect(loadMembers).not.toHaveBeenCalled();
    });
  });

  describe("cleanupCredentialSourcesAfterMemberRemoval", () => {
    test("returns 0 when the team has no agents", async ({
      makeTeam,
      makeUser,
      makeMember,
    }) => {
      const team = await makeTeam(organizationId, creatorId);
      const removed = await makeUser();
      await makeMember(removed.id, organizationId, { role: "member" });
      const cleaned = await cleanupCredentialSourcesAfterMemberRemoval({
        removedUserId: removed.id,
        teamId: team.id,
        organizationId,
      });
      expect(cleaned).toBe(0);
    });
  });
});
