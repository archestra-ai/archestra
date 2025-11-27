import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import db, { schema } from "@/database";
import { MemberModel, SessionModel } from "@/models";
import { test } from "@/test";

describe("User deletion cleanup operations", () => {
  test("should delete all sessions for a user", async ({
    makeUser,
    makeSession,
  }) => {
    const user = await makeUser();

    // Create multiple sessions for the user
    await makeSession(user.id);
    await makeSession(user.id);
    await makeSession(user.id);

    // Verify sessions exist
    const sessionsBefore = await SessionModel.getByUserId(user.id);
    expect(sessionsBefore).toHaveLength(3);

    // Delete all sessions (simulates the hook behavior)
    await SessionModel.deleteAllByUserId(user.id);

    // Verify sessions are deleted
    const sessionsAfter = await SessionModel.getByUserId(user.id);
    expect(sessionsAfter).toHaveLength(0);
  });

  test("should delete all account records for a user", async ({
    makeUser,
    makeAccount,
  }) => {
    const user = await makeUser();

    // Create multiple account records (simulating different auth providers)
    await makeAccount(user.id, { providerId: "credential" });
    await makeAccount(user.id, { providerId: "google" });
    await makeAccount(user.id, { providerId: "github" });

    // Verify accounts exist
    const accountsBefore = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    expect(accountsBefore).toHaveLength(3);

    // Delete all account records (simulates the hook behavior)
    await db
      .delete(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));

    // Verify accounts are deleted
    const accountsAfter = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    expect(accountsAfter).toHaveLength(0);
  });

  test("should handle deletion when user has both sessions and accounts", async ({
    makeUser,
    makeSession,
    makeAccount,
  }) => {
    const user = await makeUser();

    // Create sessions and accounts
    await makeSession(user.id);
    await makeSession(user.id);
    await makeAccount(user.id, { providerId: "credential" });
    await makeAccount(user.id, { providerId: "google" });

    // Verify data exists
    const sessionsBefore = await SessionModel.getByUserId(user.id);
    const accountsBefore = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    expect(sessionsBefore).toHaveLength(2);
    expect(accountsBefore).toHaveLength(2);

    // Perform cleanup (simulates the hook behavior)
    await SessionModel.deleteAllByUserId(user.id);
    await db
      .delete(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));

    // Verify all data is deleted
    const sessionsAfter = await SessionModel.getByUserId(user.id);
    const accountsAfter = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    expect(sessionsAfter).toHaveLength(0);
    expect(accountsAfter).toHaveLength(0);
  });

  test("should handle deletion when user has no sessions", async ({
    makeUser,
    makeAccount,
  }) => {
    const user = await makeUser();

    // Create only account records, no sessions
    await makeAccount(user.id);

    const accountsBefore = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    expect(accountsBefore).toHaveLength(1);

    // Delete accounts (should not fail even though no sessions exist)
    await db
      .delete(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));

    const accountsAfter = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));
    expect(accountsAfter).toHaveLength(0);
  });

  test("should handle deletion when user has no accounts", async ({
    makeUser,
    makeSession,
  }) => {
    const user = await makeUser();

    // Create only sessions, no account records
    await makeSession(user.id);

    const sessionsBefore = await SessionModel.getByUserId(user.id);
    expect(sessionsBefore).toHaveLength(1);

    // Delete sessions (should not fail even though no accounts exist)
    await SessionModel.deleteAllByUserId(user.id);

    const sessionsAfter = await SessionModel.getByUserId(user.id);
    expect(sessionsAfter).toHaveLength(0);
  });

  test("user is fully deleted when last organization membership is removed", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeSession,
    makeAccount,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    // Create single membership
    const member = await makeMember(user.id, org.id);

    // Create session and account
    await makeSession(user.id);
    await makeAccount(user.id);

    // Verify user, session, and account exist
    const userBefore = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));
    const sessionsBefore = await SessionModel.getByUserId(user.id);
    const accountsBefore = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));

    expect(userBefore).toHaveLength(1);
    expect(sessionsBefore).toHaveLength(1);
    expect(accountsBefore).toHaveLength(1);

    // Simulate the remove-member hook behavior
    // 1. Delete the membership
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.id, member.id));

    // 2. Check for remaining memberships
    const remainingMemberships = await MemberModel.getByUserId(user.id);

    if (!remainingMemberships) {
      // 3. Delete sessions
      await SessionModel.deleteAllByUserId(user.id);

      // 4. Delete accounts
      await db
        .delete(schema.accountsTable)
        .where(eq(schema.accountsTable.userId, user.id));

      // 5. Delete user
      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));
    }

    // Verify everything is deleted
    const userAfter = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));
    const sessionsAfter = await SessionModel.getByUserId(user.id);
    const accountsAfter = await db
      .select()
      .from(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, user.id));

    expect(userAfter).toHaveLength(0);
    expect(sessionsAfter).toHaveLength(0);
    expect(accountsAfter).toHaveLength(0);
  });
});
