import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@shared";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import MemberModel from "./member";

describe("MemberModel", () => {
  let testUserId: string;
  let testUser2Id: string;
  let testOrgId: string;
  let testOrg2Id: string;
  let testMemberId: string;

  beforeEach(async () => {
    testUserId = crypto.randomUUID();
    testUser2Id = crypto.randomUUID();
    testOrgId = crypto.randomUUID();
    testOrg2Id = crypto.randomUUID();
    testMemberId = crypto.randomUUID();

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
  });

  afterEach(async () => {
    // Clean up in reverse order due to foreign key constraints
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, testUserId));
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, testUser2Id));
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

  describe("create", () => {
    it.each([MEMBER_ROLE_NAME, ADMIN_ROLE_NAME, crypto.randomUUID()])(
      "should create member with %s role",
      async (role) => {
        const result = await MemberModel.create(testUserId, testOrgId, role);

        expect(result).toHaveLength(1);
        const member = result[0];
        expect(member?.id).toBeDefined();
        expect(member?.userId).toBe(testUserId);
        expect(member?.organizationId).toBe(testOrgId);
        expect(member?.role).toBe(role);
        expect(member?.createdAt).toBeInstanceOf(Date);
      },
    );

    it("should allow same user to be member of multiple organizations", async () => {
      const result1 = await MemberModel.create(
        testUserId,
        testOrgId,
        MEMBER_ROLE_NAME,
      );
      const result2 = await MemberModel.create(
        testUserId,
        testOrg2Id,
        ADMIN_ROLE_NAME,
      );

      expect(result1).toHaveLength(1);
      expect(result2).toHaveLength(1);
      expect(result1[0]?.organizationId).toBe(testOrgId);
      expect(result2[0]?.organizationId).toBe(testOrg2Id);
      expect(result1[0]?.role).toBe(MEMBER_ROLE_NAME);
      expect(result2[0]?.role).toBe(ADMIN_ROLE_NAME);
    });
  });

  describe("getByUserId", () => {
    beforeEach(async () => {
      // Create a test member
      await db.insert(schema.membersTable).values({
        id: testMemberId,
        userId: testUserId,
        organizationId: testOrgId,
        role: MEMBER_ROLE_NAME,
        createdAt: new Date(),
      });
    });

    it("should return member when user has membership", async () => {
      const member = await MemberModel.getByUserId(testUserId);

      expect(member).toBeDefined();
      expect(member?.id).toBe(testMemberId);
      expect(member?.userId).toBe(testUserId);
      expect(member?.organizationId).toBe(testOrgId);
      expect(member?.role).toBe(MEMBER_ROLE_NAME);
      expect(member?.createdAt).toBeInstanceOf(Date);
    });

    it("should return undefined when user has no membership", async () => {
      const member = await MemberModel.getByUserId(testUser2Id);
      expect(member).toBeUndefined();
    });

    it("should return undefined when user does not exist", async () => {
      const nonExistentUserId = crypto.randomUUID();
      const member = await MemberModel.getByUserId(nonExistentUserId);
      expect(member).toBeUndefined();
    });

    it("should return first membership when user has multiple memberships", async () => {
      // Create second membership for the same user
      const member2Id = crypto.randomUUID();
      await db.insert(schema.membersTable).values({
        id: member2Id,
        userId: testUserId,
        organizationId: testOrg2Id,
        role: ADMIN_ROLE_NAME,
        createdAt: new Date(),
      });

      const member = await MemberModel.getByUserId(testUserId);

      // Should return one of the memberships (implementation uses limit(1))
      expect(member).toBeDefined();
      expect(member?.userId).toBe(testUserId);
      expect([testMemberId, member2Id]).toContain(member?.id);
    });

    it("should return member with admin role", async () => {
      // Update member to have admin role
      await db
        .update(schema.membersTable)
        .set({ role: ADMIN_ROLE_NAME })
        .where(eq(schema.membersTable.id, testMemberId));

      const member = await MemberModel.getByUserId(testUserId);

      expect(member).toBeDefined();
      expect(member?.role).toBe(ADMIN_ROLE_NAME);
    });

    it("should return member with custom role", async () => {
      const customRoleId = crypto.randomUUID();
      // Update member to have custom role
      await db
        .update(schema.membersTable)
        .set({ role: customRoleId })
        .where(eq(schema.membersTable.id, testMemberId));

      const member = await MemberModel.getByUserId(testUserId);

      expect(member).toBeDefined();
      expect(member?.role).toBe(customRoleId);
    });
  });

  describe("deleteByMemberOrUserId", () => {
    let member1Id: string;
    let member2Id: string;

    beforeEach(async () => {
      member1Id = crypto.randomUUID();
      member2Id = crypto.randomUUID();

      // Create test members
      await db.insert(schema.membersTable).values([
        {
          id: member1Id,
          userId: testUserId,
          organizationId: testOrgId,
          role: MEMBER_ROLE_NAME,
          createdAt: new Date(),
        },
        {
          id: member2Id,
          userId: testUser2Id,
          organizationId: testOrg2Id,
          role: ADMIN_ROLE_NAME,
          createdAt: new Date(),
        },
      ]);
    });

    it("should delete member by member ID", async () => {
      const deleted = await MemberModel.deleteByMemberOrUserId(
        member1Id,
        testOrgId,
      );

      expect(deleted).toBeDefined();
      expect(deleted?.id).toBe(member1Id);
      expect(deleted?.userId).toBe(testUserId);

      // Verify member is actually deleted
      const remainingMember = await db
        .select()
        .from(schema.membersTable)
        .where(eq(schema.membersTable.id, member1Id))
        .limit(1);
      expect(remainingMember).toHaveLength(0);
    });

    it("should delete member by user ID and organization ID when member ID not found", async () => {
      // Use testUserId (which exists as a userId but not as a memberId)
      // to test the fallback logic
      const deleted = await MemberModel.deleteByMemberOrUserId(
        testUserId, // This will not match as member ID, but will match as user ID
        testOrgId,
      );

      // Should not find by member ID, but should find by user ID + org ID
      expect(deleted).toBeDefined();
      expect(deleted?.userId).toBe(testUserId); // testUserId is in testOrgId
      expect(deleted?.organizationId).toBe(testOrgId);

      // Verify member is actually deleted
      const remainingMember = await db
        .select()
        .from(schema.membersTable)
        .where(
          and(
            eq(schema.membersTable.userId, testUserId),
            eq(schema.membersTable.organizationId, testOrgId),
          ),
        )
        .limit(1);
      expect(remainingMember).toHaveLength(0);
    });

    it("should delete member by user ID and organization ID directly", async () => {
      const deleted = await MemberModel.deleteByMemberOrUserId(
        testUserId,
        testOrgId,
      );

      expect(deleted).toBeDefined();
      expect(deleted?.userId).toBe(testUserId);
      expect(deleted?.organizationId).toBe(testOrgId);

      // Verify member is actually deleted
      const remainingMember = await db
        .select()
        .from(schema.membersTable)
        .where(
          and(
            eq(schema.membersTable.userId, testUserId),
            eq(schema.membersTable.organizationId, testOrgId),
          ),
        )
        .limit(1);
      expect(remainingMember).toHaveLength(0);
    });

    it("should return undefined when member not found by any method", async () => {
      const nonExistentId = crypto.randomUUID();
      const nonExistentOrgId = crypto.randomUUID();

      const deleted = await MemberModel.deleteByMemberOrUserId(
        nonExistentId,
        nonExistentOrgId,
      );

      expect(deleted).toBeUndefined();
    });

    it("should return undefined when user ID exists but in wrong organization", async () => {
      const deleted = await MemberModel.deleteByMemberOrUserId(
        testUserId,
        testOrg2Id,
      );

      expect(deleted).toBeUndefined();

      // Verify original member is still there
      const remainingMember = await db
        .select()
        .from(schema.membersTable)
        .where(eq(schema.membersTable.id, member1Id))
        .limit(1);
      expect(remainingMember).toHaveLength(1);
    });

    it("should not affect other members when deleting", async () => {
      await MemberModel.deleteByMemberOrUserId(member1Id, testOrgId);

      // Verify other member is still there
      const remainingMember = await db
        .select()
        .from(schema.membersTable)
        .where(eq(schema.membersTable.id, member2Id))
        .limit(1);
      expect(remainingMember).toHaveLength(1);
      expect(remainingMember[0]?.id).toBe(member2Id);
    });

    it("should handle deletion with admin role", async () => {
      const deleted = await MemberModel.deleteByMemberOrUserId(
        member2Id,
        testOrg2Id,
      );

      expect(deleted).toBeDefined();
      expect(deleted?.role).toBe(ADMIN_ROLE_NAME);
      expect(deleted?.userId).toBe(testUser2Id);
    });

    it("should return complete member data when deleting", async () => {
      const deleted = await MemberModel.deleteByMemberOrUserId(
        member1Id,
        testOrgId,
      );

      expect(deleted).toBeDefined();
      expect(deleted?.id).toBe(member1Id);
      expect(deleted?.userId).toBe(testUserId);
      expect(deleted?.organizationId).toBe(testOrgId);
      expect(deleted?.role).toBe(MEMBER_ROLE_NAME);
      expect(deleted?.createdAt).toBeInstanceOf(Date);
    });
  });
});
