import { describe, expect } from "vitest";
import { test } from "@/test";
import { TeamModel } from "@/models";
import { IdentityResolutionService } from "./identity-resolution";
import { AclMaterializer } from "./acl-materializer";

describe("AclMaterializer", () => {
  test("materializes public permissions to org:*", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const resolver = new IdentityResolutionService(org.id);
    const materializer = new AclMaterializer(resolver);

    const result = await materializer.materialize({
      isPublic: true,
      users: ["some@user.com"],
      groups: ["some-group"],
    });

    expect(result).toEqual({
      acl: ["org:*"],
      complete: true,
      skippedGroups: [],
      resolvedEmails: [],
    });
  });

  test("resolves and materializes user emails and external groups", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const resolver = new IdentityResolutionService(org.id);
    const materializer = new AclMaterializer(resolver);

    // Create 2 users in the org
    const user1 = await makeUser({ email: "user1@example.com" });
    const user2 = await makeUser({ email: "user2@example.com" });
    await makeMember(user1.id, org.id, { role: "member" });
    await makeMember(user2.id, org.id, { role: "member" });

    // Create a user not in the org
    const userExternal = "external@example.com";

    // Create a team mapped to an external group
    const team = await makeTeam(org.id);
    await TeamModel.addExternalGroup(team.id, "external-group-1");
    // Add user2 to the team
    await makeTeamMember(team.id, user2.id);

    const result = await materializer.materialize({
      isPublic: false,
      users: ["user1@example.com", userExternal],
      groups: ["external-group-1", "unmapped-group"],
    });

    // user1@example.com is resolved because they are in the org
    // user2@example.com is resolved because they are in the team mapped to external-group-1
    // userExternal is filtered out because they are not in the org
    // unmapped-group is unmapped, so complete is false and it's in skippedGroups
    expect(result.acl).toEqual([
      "user_email:user1@example.com",
      "user_email:user2@example.com",
    ]);
    expect(result.complete).toBe(false);
    expect(result.skippedGroups).toEqual(["unmapped-group"]);
    expect(result.resolvedEmails.sort()).toEqual([
      "user1@example.com",
      "user2@example.com",
    ]);
  });

  test("returns complete true when all groups are successfully mapped", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const resolver = new IdentityResolutionService(org.id);
    const materializer = new AclMaterializer(resolver);

    const user1 = await makeUser({ email: "user1@example.com" });
    await makeMember(user1.id, org.id, { role: "member" });

    const team = await makeTeam(org.id);
    await TeamModel.addExternalGroup(team.id, "external-group-1");
    await makeTeamMember(team.id, user1.id);

    const result = await materializer.materialize({
      isPublic: false,
      users: ["user1@example.com"],
      groups: ["external-group-1"],
    });

    expect(result.acl).toEqual(["user_email:user1@example.com"]);
    expect(result.complete).toBe(true);
    expect(result.skippedGroups).toEqual([]);
  });
});
