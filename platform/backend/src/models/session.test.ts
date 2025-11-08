import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import SessionModel from "./session";

describe("SessionModel", () => {
  let testUserId: string;
  let testUser2Id: string;
  let testOrgId: string;
  let testOrg2Id: string;
  let testSessionId: string;
  let testSession2Id: string;
  let testSession3Id: string;

  beforeEach(async () => {
    testUserId = crypto.randomUUID();
    testUser2Id = crypto.randomUUID();
    testOrgId = crypto.randomUUID();
    testOrg2Id = crypto.randomUUID();
    testSessionId = crypto.randomUUID();
    testSession2Id = crypto.randomUUID();
    testSession3Id = crypto.randomUUID();

    // Create test organizations
    await db.insert(schema.organizationsTable).values([
      {
        id: testOrgId,
        name: "Test Organization",
        slug: "test-organization",
        createdAt: new Date(),
      },
      {
        id: testOrg2Id,
        name: "Test Organization 2",
        slug: "test-organization-2",
        createdAt: new Date(),
      },
    ]);

    // Create test users
    await db.insert(schema.usersTable).values([
      {
        id: testUserId,
        email: "test@example.com",
        name: "Test User",
      },
      {
        id: testUser2Id,
        email: "test2@example.com",
        name: "Test User 2",
      },
    ]);

    // Create test sessions
    await db.insert(schema.sessionsTable).values([
      {
        id: testSessionId,
        userId: testUserId,
        token: "test-token-1",
        expiresAt: new Date(Date.now() + 86400000), // 24 hours
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "192.168.1.1",
        userAgent: "Mozilla/5.0 Test Agent",
        activeOrganizationId: testOrgId,
      },
      {
        id: testSession2Id,
        userId: testUserId,
        token: "test-token-2",
        expiresAt: new Date(Date.now() + 86400000), // 24 hours
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "192.168.1.2",
        userAgent: "Another Test Agent",
      },
      {
        id: testSession3Id,
        userId: testUser2Id,
        token: "test-token-3",
        expiresAt: new Date(Date.now() + 86400000), // 24 hours
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: "192.168.1.3",
        userAgent: "Third Test Agent",
        activeOrganizationId: testOrg2Id,
      },
    ]);
  });

  afterEach(async () => {
    // Clean up in reverse order due to foreign key constraints
    await db
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, testUserId));
    await db
      .delete(schema.sessionsTable)
      .where(eq(schema.sessionsTable.userId, testUser2Id));
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, testUserId));
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, testUser2Id));
    await db
      .delete(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, testOrgId));
    await db
      .delete(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, testOrg2Id));
  });

  describe("patch", () => {
    it("should update activeOrganizationId", async () => {
      await SessionModel.patch(testSessionId, {
        activeOrganizationId: testOrg2Id,
      });

      const session = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, testSessionId))
        .limit(1);

      expect(session).toHaveLength(1);
      expect(session[0]?.activeOrganizationId).toBe(testOrg2Id);
    });

    it("should update multiple fields at once", async () => {
      const updateData = {
        activeOrganizationId: testOrg2Id,
        ipAddress: "172.16.0.1",
        userAgent: "Multi-Update Agent",
        impersonatedBy: crypto.randomUUID(),
      };

      await SessionModel.patch(testSessionId, updateData);

      const session = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, testSessionId))
        .limit(1);

      expect(session).toHaveLength(1);
      expect(session[0]?.activeOrganizationId).toBe(
        updateData.activeOrganizationId,
      );
      expect(session[0]?.ipAddress).toBe(updateData.ipAddress);
      expect(session[0]?.userAgent).toBe(updateData.userAgent);
      expect(session[0]?.impersonatedBy).toBe(updateData.impersonatedBy);
    });

    it("should handle null values", async () => {
      await SessionModel.patch(testSessionId, {
        activeOrganizationId: null,
        impersonatedBy: null,
        ipAddress: null,
        userAgent: null,
      });

      const session = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.id, testSessionId))
        .limit(1);

      expect(session).toHaveLength(1);
      expect(session[0]?.activeOrganizationId).toBeNull();
      expect(session[0]?.impersonatedBy).toBeNull();
      expect(session[0]?.ipAddress).toBeNull();
      expect(session[0]?.userAgent).toBeNull();
    });

    it("should handle non-existent session gracefully", async () => {
      const nonExistentSessionId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        SessionModel.patch(nonExistentSessionId, { ipAddress: "test-ip" }),
      ).resolves.not.toThrow();
    });
  });

  describe("deleteAllByUserId", () => {
    it("should delete all sessions for a user", async () => {
      // Verify sessions exist before deletion
      const sessionsBefore = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.userId, testUserId));

      expect(sessionsBefore).toHaveLength(2); // testSessionId and testSession2Id

      await SessionModel.deleteAllByUserId(testUserId);

      // Verify all sessions for the user are deleted
      const sessionsAfter = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.userId, testUserId));

      expect(sessionsAfter).toHaveLength(0);
    });

    it("should not affect sessions of other users", async () => {
      await SessionModel.deleteAllByUserId(testUserId);

      // Verify other user's sessions are still there
      const otherUserSessions = await db
        .select()
        .from(schema.sessionsTable)
        .where(eq(schema.sessionsTable.userId, testUser2Id));

      expect(otherUserSessions).toHaveLength(1);
      expect(otherUserSessions[0]?.id).toBe(testSession3Id);
    });

    it("should handle non-existent user gracefully", async () => {
      const nonExistentUserId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        SessionModel.deleteAllByUserId(nonExistentUserId),
      ).resolves.not.toThrow();

      // Verify existing sessions are unaffected
      const existingSessions = await db.select().from(schema.sessionsTable);

      expect(existingSessions).toHaveLength(3);
    });

    it("should handle user with no sessions", async () => {
      // First delete all sessions
      await SessionModel.deleteAllByUserId(testUserId);

      // Then try to delete again
      await expect(
        SessionModel.deleteAllByUserId(testUserId),
      ).resolves.not.toThrow();

      // Verify no errors and other sessions are unaffected
      const allSessions = await db.select().from(schema.sessionsTable);

      expect(allSessions).toHaveLength(1); // Only testUser2's session should remain
      expect(allSessions[0]?.userId).toBe(testUser2Id);
    });
  });
});
