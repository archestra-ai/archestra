import { describe, expect, test } from "@/test";
import SecretModel from "./secret";

describe("SecretModel", () => {
  describe("create", () => {
    test("should create a secret", async () => {
      const secret = await SecretModel.create({
        name: "test-secret",
        secret: { API_KEY: "test-key" },
        isVault: false,
      });

      expect(secret.id).toBeDefined();
      expect(secret.name).toBe("test-secret");
      expect(secret.secret).toEqual({ API_KEY: "test-key" });
      expect(secret.isVault).toBe(false);
      expect(secret.vaultPath).toBeNull();
    });

    test("should create a secret with vault path", async () => {
      const secret = await SecretModel.create({
        name: "external-secret",
        secret: {},
        isVault: true,
        vaultPath: "secret/data/engineering/api-keys",
      });

      expect(secret.id).toBeDefined();
      expect(secret.name).toBe("external-secret");
      expect(secret.secret).toEqual({});
      expect(secret.isVault).toBe(true);
      expect(secret.vaultPath).toBe("secret/data/engineering/api-keys");
    });
  });

  describe("findById", () => {
    test("should find a secret by ID", async () => {
      const created = await SecretModel.create({
        name: "findable-secret",
        secret: { KEY: "value" },
        isVault: false,
      });

      const found = await SecretModel.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe("findable-secret");
    });

    test("should return null for non-existent secret", async () => {
      const found = await SecretModel.findById(crypto.randomUUID());

      expect(found).toBeNull();
    });
  });

  describe("update", () => {
    test("should update a secret", async () => {
      const secret = await SecretModel.create({
        name: "updatable-secret",
        secret: { OLD_KEY: "old-value" },
        isVault: false,
      });

      const updated = await SecretModel.update(secret.id, {
        secret: { NEW_KEY: "new-value" },
      });

      expect(updated).not.toBeNull();
      expect(updated?.secret).toEqual({ NEW_KEY: "new-value" });
    });
  });

  describe("delete", () => {
    test("should delete a secret", async () => {
      const secret = await SecretModel.create({
        name: "deletable-secret",
        secret: { KEY: "value" },
        isVault: false,
      });

      const deleted = await SecretModel.delete(secret.id);
      expect(deleted).toBe(true);

      const found = await SecretModel.findById(secret.id);
      expect(found).toBeNull();
    });
  });
});
