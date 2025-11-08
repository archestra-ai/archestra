import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "@/database";
import AccountModel from "./account";

describe("AccountModel", () => {
  let testUserId: string;
  let testAccountId: string;
  let testAccount2Id: string;

  beforeEach(async () => {
    testUserId = crypto.randomUUID();
    testAccountId = crypto.randomUUID();
    testAccount2Id = crypto.randomUUID();

    // Create test user
    await db.insert(schema.usersTable).values({
      id: testUserId,
      email: "test@example.com",
      name: "Test User",
    });

    // Create test account
    await db.insert(schema.accountsTable).values({
      id: testAccountId,
      accountId: "oauth-account-123",
      providerId: "google",
      userId: testUserId,
      accessToken: "access-token-123",
      refreshToken: "refresh-token-123",
      idToken: "id-token-123",
      accessTokenExpiresAt: new Date(Date.now() + 3600000), // 1 hour
      refreshTokenExpiresAt: new Date(Date.now() + 86400000), // 24 hours
      scope: "email profile",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up in reverse order due to foreign key constraints
    await db
      .delete(schema.accountsTable)
      .where(eq(schema.accountsTable.userId, testUserId));
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, testUserId));
  });

  describe("getByUserId", () => {
    it("should return account when user has account", async () => {
      const account = await AccountModel.getByUserId(testUserId);

      expect(account).toBeDefined();
      expect(account?.id).toBe(testAccountId);
      expect(account?.userId).toBe(testUserId);
      expect(account?.accountId).toBe("oauth-account-123");
      expect(account?.providerId).toBe("google");
      expect(account?.accessToken).toBe("access-token-123");
      expect(account?.refreshToken).toBe("refresh-token-123");
      expect(account?.idToken).toBe("id-token-123");
      expect(account?.scope).toBe("email profile");
    });

    it("should return undefined when user has no account", async () => {
      const nonExistentUserId = crypto.randomUUID();
      const account = await AccountModel.getByUserId(nonExistentUserId);

      expect(account).toBeUndefined();
    });

    it("should return first account when user has multiple accounts", async () => {
      // Create a second account for the same user
      await db.insert(schema.accountsTable).values({
        id: testAccount2Id,
        accountId: "oauth-account-456",
        providerId: "github",
        userId: testUserId,
        accessToken: "access-token-456",
        refreshToken: "refresh-token-456",
        scope: "user:email",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const account = await AccountModel.getByUserId(testUserId);

      // Should return the first account (using limit(1))
      expect(account).toBeDefined();
      expect(account?.userId).toBe(testUserId);
      // Should be one of the two accounts (implementation uses limit(1) so returns first found)
      expect([testAccountId, testAccount2Id]).toContain(account?.id);
    });
  });
});
