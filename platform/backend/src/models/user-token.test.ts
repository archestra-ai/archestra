import { describe, expect, test } from "@/test";
import UserTokenModel from "./user-token";

describe("UserTokenModel", () => {
  describe("create", () => {
    test("creates token with correct format", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token, value } = await UserTokenModel.create(
        user.id,
        org.id,
        "Test Token",
      );

      expect(token.name).toBe("Test Token");
      expect(token.organizationId).toBe(org.id);
      expect(token.userId).toBe(user.id);
      expect(value).toMatch(/^archestra_[a-f0-9]{32}$/);
      expect(token.tokenStart).toBe(value.substring(0, 14));
    });

    test("creates token with default name", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token } = await UserTokenModel.create(user.id, org.id);

      expect(token.name).toBe("Personal Token");
    });
  });

  describe("findById", () => {
    test("returns token by ID", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token } = await UserTokenModel.create(
        user.id,
        org.id,
        "Test Token",
      );

      const found = await UserTokenModel.findById(token.id);
      expect(found?.id).toBe(token.id);
      expect(found?.name).toBe("Test Token");
    });

    test("returns null for non-existent ID", async () => {
      const found = await UserTokenModel.findById(crypto.randomUUID());
      expect(found).toBeNull();
    });
  });

  describe("findByUserAndOrg", () => {
    test("returns token for user in organization", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token } = await UserTokenModel.create(user.id, org.id);

      const found = await UserTokenModel.findByUserAndOrg(user.id, org.id);
      expect(found?.id).toBe(token.id);
    });

    test("returns null when no token exists", async ({
      makeUser,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const found = await UserTokenModel.findByUserAndOrg(user.id, org.id);
      expect(found).toBeNull();
    });

    test("returns correct token for user with multiple orgs", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org1.id);
      await makeMember(user.id, org2.id);

      await UserTokenModel.create(user.id, org1.id, "Org1 Token");
      await UserTokenModel.create(user.id, org2.id, "Org2 Token");

      const foundOrg1 = await UserTokenModel.findByUserAndOrg(user.id, org1.id);
      const foundOrg2 = await UserTokenModel.findByUserAndOrg(user.id, org2.id);

      expect(foundOrg1?.name).toBe("Org1 Token");
      expect(foundOrg2?.name).toBe("Org2 Token");
    });
  });

  describe("rotate", () => {
    test("rotates token and returns new value", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token, value: originalValue } = await UserTokenModel.create(
        user.id,
        org.id,
      );

      const result = await UserTokenModel.rotate(token.id);
      expect(result?.value).toBeDefined();
      expect(result?.value).not.toBe(originalValue);
      expect(result?.value.startsWith("archestra_")).toBe(true);

      const updated = await UserTokenModel.findById(token.id);
      expect(updated?.tokenStart).toBe(result?.value.substring(0, 14));
    });

    test("returns null for non-existent token", async () => {
      const result = await UserTokenModel.rotate(crypto.randomUUID());
      expect(result).toBeNull();
    });
  });

  describe("validateToken", () => {
    test("validates correct token", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token, value } = await UserTokenModel.create(user.id, org.id);

      const validated = await UserTokenModel.validateToken(value);
      expect(validated?.id).toBe(token.id);
      expect(validated?.userId).toBe(user.id);
      expect(validated?.organizationId).toBe(org.id);
    });

    test("returns null for invalid token", async () => {
      const validated = await UserTokenModel.validateToken(
        "archestra_invalidtoken1234567890",
      );
      expect(validated).toBeNull();
    });

    test("updates lastUsedAt on validation", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token, value } = await UserTokenModel.create(user.id, org.id);

      expect(token.lastUsedAt).toBeNull();

      await UserTokenModel.validateToken(value);

      const updated = await UserTokenModel.findById(token.id);
      expect(updated?.lastUsedAt).not.toBeNull();
    });
  });

  describe("getTokenValue", () => {
    test("returns full token value", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token, value } = await UserTokenModel.create(user.id, org.id);

      const retrievedValue = await UserTokenModel.getTokenValue(token.id);
      expect(retrievedValue).toBe(value);
    });

    test("returns null for non-existent token", async () => {
      const value = await UserTokenModel.getTokenValue(crypto.randomUUID());
      expect(value).toBeNull();
    });
  });

  describe("ensureUserToken", () => {
    test("creates token if not exists", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const token = await UserTokenModel.ensureUserToken(user.id, org.id);

      expect(token.userId).toBe(user.id);
      expect(token.organizationId).toBe(org.id);
      expect(token.name).toBe("Personal Token");
    });

    test("returns existing token if exists", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const first = await UserTokenModel.ensureUserToken(user.id, org.id);
      const second = await UserTokenModel.ensureUserToken(user.id, org.id);

      expect(first.id).toBe(second.id);
    });
  });

  describe("delete", () => {
    test("deletes token", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      const { token } = await UserTokenModel.create(user.id, org.id);

      const deleted = await UserTokenModel.delete(token.id);
      expect(deleted).toBe(true);

      const found = await UserTokenModel.findById(token.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent token", async () => {
      const deleted = await UserTokenModel.delete(crypto.randomUUID());
      expect(deleted).toBe(false);
    });
  });

  describe("deleteByUserAndOrg", () => {
    test("deletes token for specific user and org", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org.id);

      await UserTokenModel.create(user.id, org.id);

      const deleted = await UserTokenModel.deleteByUserAndOrg(user.id, org.id);
      expect(deleted).toBe(true);

      const found = await UserTokenModel.findByUserAndOrg(user.id, org.id);
      expect(found).toBeNull();
    });

    test("returns false when no token exists", async ({
      makeUser,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const deleted = await UserTokenModel.deleteByUserAndOrg(user.id, org.id);
      expect(deleted).toBe(false);
    });

    test("only deletes token for specified org", async ({
      makeUser,
      makeOrganization,
      makeMember,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, org1.id);
      await makeMember(user.id, org2.id);

      await UserTokenModel.create(user.id, org1.id);
      await UserTokenModel.create(user.id, org2.id);

      await UserTokenModel.deleteByUserAndOrg(user.id, org1.id);

      // org1 token should be deleted
      const foundOrg1 = await UserTokenModel.findByUserAndOrg(user.id, org1.id);
      expect(foundOrg1).toBeNull();

      // org2 token should still exist
      const foundOrg2 = await UserTokenModel.findByUserAndOrg(user.id, org2.id);
      expect(foundOrg2).not.toBeNull();
    });
  });
});
