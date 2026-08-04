import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { predefinedPermissionsMap } from "@archestra/shared/access-control";
import { eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import McpServerModel from "./mcp-server";
import MemberModel from "./member";
import SecretModel from "./secret";
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

  test("should return permissions for admin role", async ({ makeMember }) => {
    // Add user as admin member
    await makeMember(testUserId, testOrgId, { role: ADMIN_ROLE_NAME });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[ADMIN_ROLE_NAME]);
  });

  test("should return permissions for member role", async ({ makeMember }) => {
    // Add user as member
    await makeMember(testUserId, testOrgId, { role: MEMBER_ROLE_NAME });

    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual(predefinedPermissionsMap[MEMBER_ROLE_NAME]);
  });

  test("should handle multiple member records and return first", async ({
    makeMember,
  }) => {
    // This scenario is unlikely in real app but tests the limit(1) behavior
    // Add user as admin member
    await makeMember(testUserId, testOrgId, { role: ADMIN_ROLE_NAME });

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

  test("should return empty permissions for user in wrong organization", async ({
    makeOrganization,
    makeMember,
  }) => {
    // Create member in a different organization
    const wrongOrg = await makeOrganization({ name: "Wrong Organization" });
    await makeMember(testUserId, wrongOrg.id, { role: ADMIN_ROLE_NAME });

    // Try to get permissions for original organization
    const result = await UserModel.getUserPermissions(testUserId, testOrgId);

    expect(result).toEqual({});
  });
});

describe("UserModel.findByEmail", () => {
  test("should find a user by email", async ({ makeUser }) => {
    const user = await makeUser({ email: "findme@test.com" });

    const foundUser = await UserModel.findByEmail("findme@test.com");

    expect(foundUser).toBeDefined();
    expect(foundUser?.id).toBe(user.id);
    expect(foundUser?.email).toBe("findme@test.com");
  });

  test("should return undefined for non-existent email", async () => {
    const foundUser = await UserModel.findByEmail("nonexistent@test.com");

    expect(foundUser).toBeUndefined();
  });
});

describe("UserModel.delete", () => {
  test("should delete a user", async ({ makeUser }) => {
    const user = await makeUser({ email: "deleteme@test.com" });

    // Delete user
    const deleted = await UserModel.delete(user.id);

    expect(deleted).toBe(true);

    // Verify user is gone
    const foundUser = await UserModel.findByEmail("deleteme@test.com");
    expect(foundUser).toBeUndefined();
  });

  test("should delete a user after their membership is removed", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser({ email: "deleteme2@test.com" });
    const org = await makeOrganization();

    // Create membership
    await MemberModel.create(user.id, org.id, MEMBER_ROLE_NAME);

    // Must delete membership first due to foreign key constraint
    await MemberModel.deleteByMemberOrUserId(user.id, org.id);

    // Now delete user
    const deleted = await UserModel.delete(user.id);

    expect(deleted).toBe(true);

    // Verify user is gone
    const foundUser = await UserModel.findByEmail("deleteme2@test.com");
    expect(foundUser).toBeUndefined();
  });

  test("should return false for non-existent user", async () => {
    const deleted = await UserModel.delete(crypto.randomUUID());

    expect(deleted).toBe(false);
  });
});

/**
 * Deleting a user must take their personal MCP credentials with them.
 * `mcp_server.owner_id` is `set null`, so without an explicit purge the install
 * survives ownerless with its secret bag (OAuth tokens, prompted secrets) intact.
 *
 * These go through `UserModel.delete` rather than the model method directly:
 * the original bug was that the cleanup lived in better-auth's
 * `user.delete.before` hook, which a raw Drizzle delete never fires. Testing
 * the real deletion entry point is the point.
 */
describe("UserModel.delete personal MCP credential cleanup", () => {
  test("purges the user's personal MCP install and its credential secret", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const secret = await SecretModel.create({
      name: "personal-oauth",
      secret: { access_token: "at-1", refresh_token: "rt-1" },
    });
    const server = await makeMcpServer({
      ownerId: user.id,
      scope: "personal",
      serverType: "remote",
      secretId: secret.id,
    });

    await UserModel.delete(user.id);

    expect(await McpServerModel.findById(server.id)).toBeNull();
    expect(await SecretModel.findById(secret.id)).toBeNull();
  });

  test("purges soft-deleted personal installs, whose secrets uninstall deliberately retains", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const secret = await SecretModel.create({
      name: "retained-after-uninstall",
      secret: { access_token: "at-2" },
    });
    // Uninstall keeps the row + secret so a restore can recover credentials.
    // Once the owner is gone nobody can restore it, so it is pure residue.
    const server = await makeMcpServer({
      ownerId: user.id,
      scope: "personal",
      serverType: "remote",
      secretId: secret.id,
      deletedAt: new Date(),
    });

    await UserModel.delete(user.id);

    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, server.id));
    expect(row).toBeUndefined();
    expect(await SecretModel.findById(secret.id)).toBeNull();
  });

  test("leaves org- and team-scoped installs owned by the user alone", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);

    // scope is the discriminator, NOT owner_id — shared installs legitimately
    // outlive the person who happened to install them.
    const orgSecret = await SecretModel.create({
      name: "org-cred",
      secret: { access_token: "org" },
    });
    const orgServer = await makeMcpServer({
      ownerId: user.id,
      scope: "org",
      serverType: "remote",
      secretId: orgSecret.id,
    });
    const teamSecret = await SecretModel.create({
      name: "team-cred",
      secret: { access_token: "team" },
    });
    const teamServer = await makeMcpServer({
      ownerId: user.id,
      scope: "team",
      teamId: team.id,
      serverType: "remote",
      secretId: teamSecret.id,
    });

    await UserModel.delete(user.id);

    expect(await McpServerModel.findById(orgServer.id)).not.toBeNull();
    expect(await SecretModel.findById(orgSecret.id)).not.toBeNull();
    expect(await McpServerModel.findById(teamServer.id)).not.toBeNull();
    expect(await SecretModel.findById(teamSecret.id)).not.toBeNull();
  });

  test("leaves another user's personal install alone", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const deletedUser = await makeUser();
    const otherUser = await makeUser();
    const otherSecret = await SecretModel.create({
      name: "other-cred",
      secret: { access_token: "other" },
    });
    const otherServer = await makeMcpServer({
      ownerId: otherUser.id,
      scope: "personal",
      serverType: "remote",
      secretId: otherSecret.id,
    });

    await UserModel.delete(deletedUser.id);

    expect(await McpServerModel.findById(otherServer.id)).not.toBeNull();
    expect(await SecretModel.findById(otherSecret.id)).not.toBeNull();
  });

  test("still deletes the user when an install carries no secret", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const server = await makeMcpServer({
      ownerId: user.id,
      scope: "personal",
      serverType: "remote",
      secretId: null,
    });

    expect(await UserModel.delete(user.id)).toBe(true);
    expect(await McpServerModel.findById(server.id)).toBeNull();
  });

  // Regression: the auth flows (rejected-SSO cleanup, linked-IdP temp users)
  // call UserModel.delete inside withDbTransaction. Cleanup running on the
  // base connection while the caller's transaction is open deadlocks the
  // single-connection test database — this test hangs, not fails, if that
  // regresses.
  test("delete inside a caller's transaction purges installs on the same executor", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const plainSecret = await SecretModel.create({
      name: "tx-plain",
      secret: { access_token: "at-tx" },
    });
    const plainServer = await makeMcpServer({
      ownerId: user.id,
      scope: "personal",
      serverType: "remote",
      secretId: plainSecret.id,
    });
    const vaultSecret = await SecretModel.create({
      name: "tx-vault",
      secret: { vaultPath: "kv/data/creds" },
      isVault: true,
    });
    const vaultServer = await makeMcpServer({
      ownerId: user.id,
      scope: "personal",
      serverType: "remote",
      secretId: vaultSecret.id,
    });

    await withDbTransaction(async (tx) => {
      expect(await UserModel.delete(user.id, tx)).toBe(true);
    });

    const [userRow] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));
    expect(userRow).toBeUndefined();
    expect(await McpServerModel.findById(plainServer.id)).toBeNull();
    expect(await McpServerModel.findById(vaultServer.id)).toBeNull();
    expect(await SecretModel.findById(plainSecret.id)).toBeNull();
    // Vault-backed secret rows survive: SQL cannot purge the backing store,
    // and the row is the only pointer left for a manual sweep.
    expect(await SecretModel.findById(vaultSecret.id)).not.toBeNull();
  });
});
