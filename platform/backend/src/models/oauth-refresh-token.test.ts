import { describe, expect, test } from "@/test";
import OAuthRefreshTokenModel from "./oauth-refresh-token";

const APP_REF = "mcp-app-resource:https://host/api/mcp/app/app-1";
const OTHER_REF = "mcp-app-resource:https://host/api/mcp/app/app-2";

describe("OAuthRefreshTokenModel", () => {
  describe("getById", () => {
    test("returns the row's id and (initially null) referenceId", async ({
      makeUser,
      makeOAuthClient,
      makeOAuthRefreshToken,
    }) => {
      const user = await makeUser();
      const client = await makeOAuthClient({ userId: user.id });
      const refreshToken = await makeOAuthRefreshToken(
        client.clientId,
        user.id,
      );

      const found = await OAuthRefreshTokenModel.getById(refreshToken.id);

      expect(found?.id).toBe(refreshToken.id);
      expect(found?.referenceId).toBeNull();
    });

    test("returns null when the id does not match", async () => {
      const found = await OAuthRefreshTokenModel.getById(crypto.randomUUID());

      expect(found).toBeNull();
    });

    test("reflects a binding written by bindReferenceIdByIdWhenUnbound", async ({
      makeUser,
      makeOAuthClient,
      makeOAuthRefreshToken,
    }) => {
      const user = await makeUser();
      const client = await makeOAuthClient({ userId: user.id });
      const refreshToken = await makeOAuthRefreshToken(
        client.clientId,
        user.id,
      );

      await OAuthRefreshTokenModel.bindReferenceIdByIdWhenUnbound({
        id: refreshToken.id,
        referenceId: APP_REF,
      });

      const found = await OAuthRefreshTokenModel.getById(refreshToken.id);
      expect(found?.referenceId).toBe(APP_REF);
    });
  });

  describe("bindReferenceIdByIdWhenUnbound", () => {
    test("binds the audience when the token is still unbound", async ({
      makeUser,
      makeOAuthClient,
      makeOAuthRefreshToken,
    }) => {
      const user = await makeUser();
      const client = await makeOAuthClient({ userId: user.id });
      const refreshToken = await makeOAuthRefreshToken(
        client.clientId,
        user.id,
      );

      const bound = await OAuthRefreshTokenModel.bindReferenceIdByIdWhenUnbound(
        {
          id: refreshToken.id,
          referenceId: APP_REF,
        },
      );

      expect(bound?.referenceId).toBe(APP_REF);
    });

    test("never overwrites a token that is already bound", async ({
      makeUser,
      makeOAuthClient,
      makeOAuthRefreshToken,
    }) => {
      const user = await makeUser();
      const client = await makeOAuthClient({ userId: user.id });
      const refreshToken = await makeOAuthRefreshToken(
        client.clientId,
        user.id,
      );
      await OAuthRefreshTokenModel.bindReferenceIdByIdWhenUnbound({
        id: refreshToken.id,
        referenceId: APP_REF,
      });

      const rebind =
        await OAuthRefreshTokenModel.bindReferenceIdByIdWhenUnbound({
          id: refreshToken.id,
          referenceId: OTHER_REF,
        });

      expect(rebind).toBeNull();
      const found = await OAuthRefreshTokenModel.getById(refreshToken.id);
      expect(found?.referenceId).toBe(APP_REF);
    });

    test("returns null when the id does not match", async () => {
      const bound = await OAuthRefreshTokenModel.bindReferenceIdByIdWhenUnbound(
        {
          id: crypto.randomUUID(),
          referenceId: APP_REF,
        },
      );

      expect(bound).toBeNull();
    });
  });
});
