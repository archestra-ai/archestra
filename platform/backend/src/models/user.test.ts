import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  predefinedPermissionsMap,
} from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import type { InsertOrganizationRole } from "@/types";
import UserModel from "./user";

describe("User.getUserPermissions", () => {
  let testOrgId: string;
  let testUserId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    testOrgId = org.id;
    testUserId = user.id;
  });

  test("should return empty permissions when user is not a member", async () => {
    const result = await UserModel.getUserPermissions(testUserId, testOrgId);
    expect(result).toEqual({});
  });

  test("should return permissions for admin role", async () => {
    // Add user as admin member
    await db.insert(schema.membersTable).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: ADMIN_ROLE_NAME,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  test("should return permissions for member role", async () => {
    // Add user as member
    await db.insert(schema.membersTable).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: MEMBER_ROLE_NAME,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[MEMBER_ROLE_NAME]);
  });

  test("should return permissions for custom role", async () => {
    // Create a custom role via direct DB insert
    const customRole: InsertOrganizationRole = {
      role: "custom_role",
      name: "Custom Role",
      organizationId: testOrgId,
      permission: { profile: ["read", "create"] },
    };
    const [createdRole] = await db
      .insert(schema.organizationRolesTable)
      .values({
        id: crypto.randomUUID(),
        ...customRole,
        permission: JSON.stringify(customRole.permission),
      })
      .returning();

    // Add user with custom role
    await db.insert(schema.membersTable).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: createdRole.role,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({
      profile: ["read", "create"],
    });
  });

  test("should handle multiple member records and return first", async () => {
    // This scenario is unlikely in real app but tests the limtest(1) behavior
    // Add user as admin member
    await db.insert(schema.membersTable).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: ADMIN_ROLE_NAME,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    // Should get admin permissions (from first/only record)
    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  test("should return empty permissions for non-existent user", async () => {
    const nonExistentUserId = crypto.randomUUID();

    const result = await UserModel.getUserPermissions(
      nonExistentUserId,
      testOrgId,
    );

    expect(result).toEqual({});
  });

  test("should return empty permissions for user in wrong organization", async () => {
    const wrongOrgId = crypto.randomUUID();

    // Create member in different organization
    await db.insert(schema.organizationsTable).values({
      id: wrongOrgId,
      name: "Wrong Organization",
      slug: "wrong-organization",
      createdAt: new Date(),
    });

    await db.insert(schema.membersTable).values({
      userId: testUserId,
      organizationId: wrongOrgId,
      role: ADMIN_ROLE_NAME,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    // Try to get permissions for original organization
    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({});

    // Cleanup
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.organizationId, wrongOrgId));
    await db
      .delete(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, wrongOrgId));
  });

  test("should handle custom role that no longer exists", async () => {
    // Add user with custom role that doesn't exist
    await db.insert(schema.membersTable).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: crypto.randomUUID(),
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    // Should return empty permissions when role doesn't exist
    expect(result).toEqual({});
  });
});
