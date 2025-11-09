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
});
