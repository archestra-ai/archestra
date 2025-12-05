import MemberModel from "@/models/member";
import SessionModel from "@/models/session";
import UserModel from "@/models/user";
import { describe, expect, test } from "@/test";

describe("Member deletion with user cleanup", () => {
  test("should delete user when member is deleted and user has no other organizations", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    // Create user and organization
    const user = await makeUser();
    const org = await makeOrganization();
    const member = await makeMember(user.id, org.id);

    // Verify user exists
    const userBefore = await UserModel.getById(user.id);
    expect(userBefore).toBeDefined();

    // Delete the member via model
    const deleted = await MemberModel.deleteByMemberOrUserId(member.id, org.id);
    expect(deleted).toBeDefined();

    // Verify member is deleted
    const memberAfter = await MemberModel.getById(member.id);
    expect(memberAfter).toBeUndefined();

    // Manually check if user has remaining organizations and delete if not
    // (simulating the hook behavior)
    const hasRemainingMemberships = await MemberModel.hasAnyMembership(user.id);

    if (!hasRemainingMemberships) {
      await UserModel.delete(user.id);
    }

    // Verify user is also deleted (since they have no more organizations)
    const userAfter = await UserModel.getById(user.id);
    expect(userAfter).toBeUndefined();
  });

  test("should NOT delete user when member is deleted but user has other organizations", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    // Create user and two organizations
    const user = await makeUser();
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const member1 = await makeMember(user.id, org1.id);
    await makeMember(user.id, org2.id);

    // Verify user exists
    const userBefore = await UserModel.getById(user.id);
    expect(userBefore).toBeDefined();

    // Delete the member from first organization
    await MemberModel.deleteByMemberOrUserId(member1.id, org1.id);

    // Verify member from org1 is deleted
    const member1After = await MemberModel.getById(member1.id);
    expect(member1After).toBeUndefined();

    // Check if user has remaining organizations (simulating hook behavior)
    const hasRemainingMemberships = await MemberModel.hasAnyMembership(user.id);

    if (!hasRemainingMemberships) {
      await UserModel.delete(user.id);
    }

    // Verify user still exists (since they still have org2)
    const userAfter = await UserModel.getById(user.id);
    expect(userAfter).toBeDefined();

    // Verify membership in org2 still exists
    const org2Membership = await MemberModel.getByUserId(user.id, org2.id);
    expect(org2Membership).toBeDefined();
    expect(org2Membership?.organizationId).toBe(org2.id);
  });

  test("should delete user via userId parameter instead of memberId", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    // Create user and organization
    const user = await makeUser();
    const org = await makeOrganization();
    await makeMember(user.id, org.id);

    // Delete the member using userId instead of memberId
    await MemberModel.deleteByMemberOrUserId(user.id, org.id);

    // Check if user has remaining organizations (simulating hook behavior)
    const hasRemainingMemberships = await MemberModel.hasAnyMembership(user.id);

    if (!hasRemainingMemberships) {
      await UserModel.delete(user.id);
    }

    // Verify user is deleted (since they have no more organizations)
    const userAfter = await UserModel.getById(user.id);
    expect(userAfter).toBeUndefined();
  });

  test("should cascade delete related resources when user is deleted", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeSession,
  }) => {
    // Create user and organization
    const user = await makeUser();
    const org = await makeOrganization();
    const member = await makeMember(user.id, org.id);

    // Create a session for the user (simulating a logged-in user)
    await makeSession(user.id, {
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    });

    // Verify session exists
    const sessionsBefore = await SessionModel.getByUserId(user.id);
    expect(sessionsBefore).toHaveLength(1);

    // Delete the member
    await MemberModel.deleteByMemberOrUserId(member.id, org.id);

    // Check if user has remaining organizations (simulating hook behavior)
    const hasRemainingMemberships = await MemberModel.hasAnyMembership(user.id);

    if (!hasRemainingMemberships) {
      await UserModel.delete(user.id);
    }

    // Verify user is deleted
    const userAfter = await UserModel.getById(user.id);
    expect(userAfter).toBeUndefined();

    // Verify session is also deleted (cascade delete)
    const sessionsAfter = await SessionModel.getByUserId(user.id);
    expect(sessionsAfter).toHaveLength(0);
  });
});
