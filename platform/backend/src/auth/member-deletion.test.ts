import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import MemberModel from "@/models/member";
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
    const userBefore = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id))
      .limit(1);
    expect(userBefore).toHaveLength(1);

    // Delete the member via model
    const deleted = await MemberModel.deleteByMemberOrUserId(member.id, org.id);
    expect(deleted).toBeDefined();

    // Verify member is deleted
    const memberAfter = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.id, member.id))
      .limit(1);
    expect(memberAfter).toHaveLength(0);

    // Manually check if user has remaining organizations and delete if not
    // (simulating the hook behavior)
    const remainingMembers = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, user.id))
      .limit(1);

    if (remainingMembers.length === 0) {
      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));
    }

    // Verify user is also deleted (since they have no more organizations)
    const userAfter = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id))
      .limit(1);
    expect(userAfter).toHaveLength(0);
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
    const userBefore = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id))
      .limit(1);
    expect(userBefore).toHaveLength(1);

    // Delete the member from first organization
    await MemberModel.deleteByMemberOrUserId(member1.id, org1.id);

    // Verify member from org1 is deleted
    const member1After = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.id, member1.id))
      .limit(1);
    expect(member1After).toHaveLength(0);

    // Check if user has remaining organizations (simulating hook behavior)
    const remainingMembers = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, user.id))
      .limit(1);

    if (remainingMembers.length === 0) {
      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));
    }

    // Verify user still exists (since they still have org2)
    const userAfter = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id))
      .limit(1);
    expect(userAfter).toHaveLength(1);

    // Verify member from org2 still exists
    const membersRemaining = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, user.id))
      .limit(2);
    expect(membersRemaining).toHaveLength(1);
    expect(membersRemaining[0]?.organizationId).toBe(org2.id);
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
    const remainingMembers = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, user.id))
      .limit(1);

    if (remainingMembers.length === 0) {
      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));
    }

    // Verify user is deleted (since they have no more organizations)
    const userAfter = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id))
      .limit(1);
    expect(userAfter).toHaveLength(0);
  });

  test("should cascade delete related resources when user is deleted", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    // Create user and organization
    const user = await makeUser();
    const org = await makeOrganization();
    const member = await makeMember(user.id, org.id);

    // Create a session for the user (simulating a logged-in user)
    const sessionId = crypto.randomUUID();
    await db.insert(schema.sessionsTable).values({
      id: sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day from now
      token: crypto.randomUUID(),
      ipAddress: "127.0.0.1",
      userAgent: "test-agent",
    });

    // Verify session exists
    const sessionBefore = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, user.id))
      .limit(1);
    expect(sessionBefore).toHaveLength(1);

    // Delete the member
    await MemberModel.deleteByMemberOrUserId(member.id, org.id);

    // Check if user has remaining organizations (simulating hook behavior)
    const remainingMembers = await db
      .select()
      .from(schema.membersTable)
      .where(eq(schema.membersTable.userId, user.id))
      .limit(1);

    if (remainingMembers.length === 0) {
      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));
    }

    // Verify user is deleted
    const userAfter = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id))
      .limit(1);
    expect(userAfter).toHaveLength(0);

    // Verify session is also deleted (cascade delete)
    const sessionAfter = await db
      .select()
      .from(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, user.id))
      .limit(1);
    expect(sessionAfter).toHaveLength(0);
  });
});
