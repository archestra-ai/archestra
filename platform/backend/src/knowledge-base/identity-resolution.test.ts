import { describe, expect } from "vitest";
import { TeamModel } from "@/models";
import { test } from "@/test";
import { IdentityResolutionService } from "./identity-resolution";

describe("IdentityResolutionService", () => {
  describe("resolveEmailsToMembers", () => {
    test("returns only emails that match active org members", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const user1 = await makeUser({ email: "alice@example.com" });
      const user2 = await makeUser({ email: "bob@example.com" });
      await makeMember(user1.id, org.id, { role: "member" });
      await makeMember(user2.id, org.id, { role: "member" });

      const result = await resolver.resolveEmailsToMembers([
        "alice@example.com",
        "bob@example.com",
        "stranger@example.com",
      ]);

      expect(result.sort()).toEqual(["alice@example.com", "bob@example.com"]);
    });

    test("is case-insensitive", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const user = await makeUser({ email: "Alice@Example.COM" });
      await makeMember(user.id, org.id, { role: "member" });

      const result = await resolver.resolveEmailsToMembers([
        "alice@example.com",
        "ALICE@EXAMPLE.COM",
        "Alice@Example.COM",
      ]);

      // All three should match the same member (case-insensitive)
      expect(result).toHaveLength(3);
    });

    test("returns empty array when no emails match", async ({
      makeOrganization,
      makeUser,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      // Create a member in a different org context — not matching
      const user = await makeUser({ email: "member@example.com" });
      const otherOrg = await makeOrganization();
      await makeMember(user.id, otherOrg.id, { role: "member" });

      const result = await resolver.resolveEmailsToMembers([
        "stranger1@example.com",
        "stranger2@example.com",
      ]);

      expect(result).toEqual([]);
    });

    test("returns empty array for empty input", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const result = await resolver.resolveEmailsToMembers([]);

      expect(result).toEqual([]);
    });
  });

  describe("resolveGroupsToEmails", () => {
    test("resolves mapped groups to team member emails", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const user1 = await makeUser({ email: "user1@example.com" });
      const user2 = await makeUser({ email: "user2@example.com" });
      await makeMember(user1.id, org.id, { role: "member" });
      await makeMember(user2.id, org.id, { role: "member" });

      const team = await makeTeam(org.id, user1.id);
      await TeamModel.addExternalGroup(team.id, "ext-group-a");
      await makeTeamMember(team.id, user1.id);
      await makeTeamMember(team.id, user2.id);

      const result = await resolver.resolveGroupsToEmails(["ext-group-a"]);

      expect(result.resolvedEmails.sort()).toEqual([
        "user1@example.com",
        "user2@example.com",
      ]);
      expect(result.unmappedGroups).toEqual([]);
    });

    test("returns unmapped groups when no team mapping exists", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const result = await resolver.resolveGroupsToEmails([
        "nonexistent-group-1",
        "nonexistent-group-2",
      ]);

      expect(result.resolvedEmails).toEqual([]);
      expect(result.unmappedGroups).toEqual([
        "nonexistent-group-1",
        "nonexistent-group-2",
      ]);
    });

    test("deduplicates resolved emails", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const user = await makeUser({ email: "shared@example.com" });
      await makeMember(user.id, org.id, { role: "member" });

      // Create two teams, both mapped to different external groups, both containing the same user
      const teamA = await makeTeam(org.id, user.id);
      await TeamModel.addExternalGroup(teamA.id, "ext-group-x");
      await makeTeamMember(teamA.id, user.id);

      const teamB = await makeTeam(org.id, user.id);
      await TeamModel.addExternalGroup(teamB.id, "ext-group-y");
      await makeTeamMember(teamB.id, user.id);

      const result = await resolver.resolveGroupsToEmails([
        "ext-group-x",
        "ext-group-y",
      ]);

      // The same email should appear only once, deduplicated
      expect(result.resolvedEmails).toEqual(["shared@example.com"]);
      expect(result.unmappedGroups).toEqual([]);
    });

    test("handles empty input", async ({ makeOrganization }) => {
      const org = await makeOrganization();
      const resolver = new IdentityResolutionService(org.id);

      const result = await resolver.resolveGroupsToEmails([]);

      expect(result.resolvedEmails).toEqual([]);
      expect(result.unmappedGroups).toEqual([]);
    });
  });
});
