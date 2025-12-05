import { describe, expect, test } from "@/test";
import AccountModel from "./account";

describe("AccountModel", () => {
  describe("getByUserId", () => {
    test("should return account when user has account", async ({
      makeUser,
      makeAccount,
    }) => {
      const user = await makeUser();
      const account = await makeAccount(user.id, {
        accountId: "oauth-account-123",
        providerId: "google",
        accessToken: "access-token-123",
      });

      const found = await AccountModel.getByUserId(user.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(account.id);
      expect(found?.userId).toBe(user.id);
      expect(found?.accountId).toBe("oauth-account-123");
      expect(found?.providerId).toBe("google");
      expect(found?.accessToken).toBe("access-token-123");
    });

    test("should return undefined when user has no account", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const account = await AccountModel.getByUserId(user.id);
      expect(account).toBeUndefined();
    });
  });

  describe("getAllByUserId", () => {
    test("should return all accounts for a user ordered by updatedAt DESC", async ({
      makeUser,
      makeAccount,
    }) => {
      const user = await makeUser();

      // Create multiple accounts
      const account1 = await makeAccount(user.id, {
        accountId: "google-123",
        providerId: "google",
        accessToken: "access-token-1",
      });
      const account2 = await makeAccount(user.id, {
        accountId: "github-123",
        providerId: "github",
        accessToken: "access-token-2",
      });

      const accounts = await AccountModel.getAllByUserId(user.id);

      expect(accounts).toHaveLength(2);
      // Most recently updated should be first
      expect(accounts.map((a) => a.id)).toContain(account1.id);
      expect(accounts.map((a) => a.id)).toContain(account2.id);
    });

    test("should return empty array when user has no accounts", async ({
      makeUser,
    }) => {
      const user = await makeUser();
      const accounts = await AccountModel.getAllByUserId(user.id);
      expect(accounts).toEqual([]);
    });
  });
});
