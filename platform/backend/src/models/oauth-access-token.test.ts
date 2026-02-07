import { describe, expect, test } from "@/test";
import OAuthAccessTokenModel from "./oauth-access-token";

describe("OAuthAccessTokenModel", () => {
  describe("getByTokenHash", () => {
    test("should return access token when hash matches", async ({
      makeUser,
      makeOAuthClient,
      makeOAuthAccessToken,
    }) => {
      const user = await makeUser();
      const client = await makeOAuthClient({ userId: user.id });
      const accessToken = await makeOAuthAccessToken(client.clientId, user.id, {
        token: "hashed-token-value",
      });

      const found =
        await OAuthAccessTokenModel.getByTokenHash("hashed-token-value");

      expect(found).toBeDefined();
      expect(found?.id).toBe(accessToken.id);
      expect(found?.userId).toBe(user.id);
      expect(found?.clientId).toBe(client.clientId);
    });

    test("should return undefined when hash does not match", async () => {
      const found =
        await OAuthAccessTokenModel.getByTokenHash("nonexistent-hash");

      expect(found).toBeUndefined();
    });

    test("should return token even if expired (expiry checked by caller)", async ({
      makeUser,
      makeOAuthClient,
      makeOAuthAccessToken,
    }) => {
      const user = await makeUser();
      const client = await makeOAuthClient({ userId: user.id });
      await makeOAuthAccessToken(client.clientId, user.id, {
        token: "expired-token-hash",
        expiresAt: new Date(Date.now() - 3600000), // expired 1h ago
      });

      const found =
        await OAuthAccessTokenModel.getByTokenHash("expired-token-hash");

      // Model returns the token regardless; expiry checking is the caller's job
      expect(found).toBeDefined();
      expect(found?.token).toBe("expired-token-hash");
    });
  });
});
