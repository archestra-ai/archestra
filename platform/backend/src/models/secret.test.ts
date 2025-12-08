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
  });

  describe("createWithVaultPath", () => {
    test("should create a BYOS secret with vault path", async () => {
      const secret = await SecretModel.createWithVaultPath({
        name: "external-secret",
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

  describe("isExternalVaultSecret", () => {
    test("should return true for BYOS secret", async () => {
      const secret = await SecretModel.createWithVaultPath({
        name: "byos-secret",
        vaultPath: "secret/data/team/credentials",
      });

      const isExternal = await SecretModel.isExternalVaultSecret(secret.id);

      expect(isExternal).toBe(true);
    });

    test("should return false for regular secret", async () => {
      const secret = await SecretModel.create({
        name: "regular-secret",
        secret: { KEY: "value" },
        isVault: false,
      });

      const isExternal = await SecretModel.isExternalVaultSecret(secret.id);

      expect(isExternal).toBe(false);
    });

    test("should return false for Archestra-managed vault secret", async () => {
      const secret = await SecretModel.create({
        name: "archestra-vault-secret",
        secret: { KEY: "value" },
        isVault: true,
        // No vaultPath - it's Archestra-managed
      });

      const isExternal = await SecretModel.isExternalVaultSecret(secret.id);

      expect(isExternal).toBe(false);
    });
  });

  describe("findByVaultPathPrefix", () => {
    test("should find secrets matching path prefix", async () => {
      await SecretModel.createWithVaultPath({
        name: "secret-1",
        vaultPath: "secret/data/engineering/api-keys",
      });
      await SecretModel.createWithVaultPath({
        name: "secret-2",
        vaultPath: "secret/data/engineering/db-creds",
      });
      await SecretModel.createWithVaultPath({
        name: "secret-3",
        vaultPath: "secret/data/finance/budgets",
      });

      const secrets = await SecretModel.findByVaultPathPrefix(
        "secret/data/engineering",
      );

      expect(secrets).toHaveLength(2);
      expect(secrets.map((s) => s.name).sort()).toEqual([
        "secret-1",
        "secret-2",
      ]);
    });

    test("should return empty array when no matches", async () => {
      await SecretModel.createWithVaultPath({
        name: "unrelated",
        vaultPath: "secret/data/other/path",
      });

      const secrets = await SecretModel.findByVaultPathPrefix(
        "secret/data/engineering",
      );

      expect(secrets).toEqual([]);
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
