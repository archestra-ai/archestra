import { beforeEach, describe, expect, test } from "@/test";
import SessionModel from "./session";

describe("SessionModel", () => {
  let testUserId: string;
  let testUser2Id: string;
  let testOrg2Id: string;
  let testSessionId: string;
  let testSession3Id: string;

  beforeEach(async ({ makeOrganization, makeUser, makeSession }) => {
    // Create test organizations
    const org = await makeOrganization();
    const org2 = await makeOrganization();
    const user = await makeUser();
    const user2 = await makeUser();

    testUserId = user.id;
    testUser2Id = user2.id;
    testOrg2Id = org2.id;

    // Create test sessions - 2 for user1, 1 for user2 (total 3)
    const session1 = await makeSession(user.id, {
      activeOrganizationId: org.id,
    });
    await makeSession(user.id); // Second session for user1
    const session3 = await makeSession(user2.id, {
      activeOrganizationId: org2.id,
    });

    testSessionId = session1.id;
    testSession3Id = session3.id;
  });

  describe("patch", () => {
    test("should update activeOrganizationId", async () => {
      await SessionModel.patch(testSessionId, {
        activeOrganizationId: testOrg2Id,
      });

      const session = await SessionModel.getById(testSessionId);

      expect(session).toHaveLength(1);
      expect(session[0]?.activeOrganizationId).toBe(testOrg2Id);
    });

    test("should update multiple fields at once", async () => {
      const updateData = {
        activeOrganizationId: testOrg2Id,
        ipAddress: "172.16.0.1",
        userAgent: "Multi-Update Agent",
        impersonatedBy: crypto.randomUUID(),
      };

      await SessionModel.patch(testSessionId, updateData);

      const session = await SessionModel.getById(testSessionId);

      expect(session).toHaveLength(1);
      expect(session[0]?.activeOrganizationId).toBe(
        updateData.activeOrganizationId,
      );
      expect(session[0]?.ipAddress).toBe(updateData.ipAddress);
      expect(session[0]?.userAgent).toBe(updateData.userAgent);
      expect(session[0]?.impersonatedBy).toBe(updateData.impersonatedBy);
    });

    test("should handle null values", async () => {
      await SessionModel.patch(testSessionId, {
        activeOrganizationId: null,
        impersonatedBy: null,
        ipAddress: null,
        userAgent: null,
      });

      const session = await SessionModel.getById(testSessionId);

      expect(session).toHaveLength(1);
      expect(session[0]?.activeOrganizationId).toBeNull();
      expect(session[0]?.impersonatedBy).toBeNull();
      expect(session[0]?.ipAddress).toBeNull();
      expect(session[0]?.userAgent).toBeNull();
    });

    test("should handle non-existent session gracefully", async () => {
      const nonExistentSessionId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        SessionModel.patch(nonExistentSessionId, { ipAddress: "test-ip" }),
      ).resolves.not.toThrow();
    });
  });

  describe("deleteAllByUserId", () => {
    test("should delete all sessions for a user", async () => {
      // Verify sessions exist before deletion
      const sessionsBefore = await SessionModel.getByUserId(testUserId);
      expect(sessionsBefore).toHaveLength(2); // testSessionId and testSession2Id

      await SessionModel.deleteAllByUserId(testUserId);

      // Verify all sessions for the user are deleted
      const sessionsAfter = await SessionModel.getByUserId(testUserId);
      expect(sessionsAfter).toHaveLength(0);
    });

    test("should not affect sessions of other users", async () => {
      await SessionModel.deleteAllByUserId(testUserId);

      // Verify other user's sessions are still there
      const otherUserSessions = await SessionModel.getByUserId(testUser2Id);
      expect(otherUserSessions).toHaveLength(1);
      expect(otherUserSessions[0]?.id).toBe(testSession3Id);
    });

    test("should handle non-existent user gracefully", async () => {
      const nonExistentUserId = crypto.randomUUID();

      // Should not throw an error
      await expect(
        SessionModel.deleteAllByUserId(nonExistentUserId),
      ).resolves.not.toThrow();

      // Verify existing sessions are unaffected
      const existingSessions = await SessionModel.getAll();

      expect(existingSessions).toHaveLength(3);
    });

    test("should handle user with no sessions", async () => {
      // First delete all sessions
      await SessionModel.deleteAllByUserId(testUserId);

      // Then try to delete again
      await expect(
        SessionModel.deleteAllByUserId(testUserId),
      ).resolves.not.toThrow();

      // Verify no errors and other sessions are unaffected
      const allSessions = await SessionModel.getAll();

      expect(allSessions).toHaveLength(1); // Only testUser2's session should remain
      expect(allSessions[0]?.userId).toBe(testUser2Id);
    });
  });
});
