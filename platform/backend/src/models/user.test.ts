import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  predefinedPermissionsMap,
} from "@shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import type { InsertOrganizationRole } from "@/types";
import OrganizationRoleModel from "./organization-role";
import UserModel from "./user";

describe("User.getUserPermissions", () => {
  let testOrgId: string;
  let testUserId: string;

  beforeEach(async () => {
    testOrgId = crypto.randomUUID();
    testUserId = crypto.randomUUID();

    // Create test organization
    await db.insert(schema.organizationsTable).values({
      id: testOrgId,
      name: "Test Organization",
      slug: "test-organization",
      createdAt: new Date(),
    });

    // Create test user
    await db.insert(schema.usersTable).values({
      id: testUserId,
      email: "test@example.com",
      name: "Test User",
    });
  });

  afterEach(async () => {
    // Clean up in reverse order due to foreign key constraints
    await db.delete(schema.member).where(eq(schema.member.userId, testUserId));
    await db
      .delete(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.organizationId, testOrgId));
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, testUserId));
    await db
      .delete(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, testOrgId));
  });

  it("should return empty permissions when user is not a member", async () => {
    const result = await UserModel.getUserPermissions(testUserId, testOrgId);
    expect(result).toEqual({});
  });

  it("should return permissions for admin role", async () => {
    // Add user as admin member
    await db.insert(schema.member).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: ADMIN_ROLE_NAME,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  it("should return permissions for member role", async () => {
    // Add user as member
    await db.insert(schema.member).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: MEMBER_ROLE_NAME,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[MEMBER_ROLE_NAME]);
  });

  it("should return permissions for custom role", async () => {
    // Create a custom role
    const customRoleId = crypto.randomUUID();
    const customRole: InsertOrganizationRole = {
      id: customRoleId,
      name: "Custom Role",
      organizationId: testOrgId,
      permission: { agent: ["read", "create"] },
    };
    await OrganizationRoleModel.create(customRole);

    // Add user with custom role
    await db.insert(schema.member).values({
      userId: testUserId,
      organizationId: testOrgId,
      role: customRoleId,
      createdAt: new Date(),
      id: crypto.randomUUID(),
    });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({
      agent: ["read", "create"],
    });
  });

  it("should handle multiple member records and return first", async () => {
    // This scenario is unlikely in real app but tests the limit(1) behavior
    // Add user as admin member
    await db.insert(schema.member).values({
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

  it("should return empty permissions for non-existent user", async () => {
    const nonExistentUserId = crypto.randomUUID();

    const result = await UserModel.getUserPermissions(
      nonExistentUserId,
      testOrgId,
    );

    expect(result).toEqual({});
  });

  it("should return empty permissions for user in wrong organization", async () => {
    const wrongOrgId = crypto.randomUUID();

    // Create member in different organization
    await db.insert(schema.organizationsTable).values({
      id: wrongOrgId,
      name: "Wrong Organization",
      slug: "wrong-organization",
      createdAt: new Date(),
    });

    await db.insert(schema.member).values({
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
      .delete(schema.member)
      .where(eq(schema.member.organizationId, wrongOrgId));
    await db
      .delete(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, wrongOrgId));
  });

  it("should handle custom role that no longer exists", async () => {
    // Add user with custom role that doesn't exist
    await db.insert(schema.member).values({
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
