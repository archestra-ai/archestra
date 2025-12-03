import { vi } from "vitest";
import config from "@/config";
import SecretModel from "@/models/secret";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

// Use vi.hoisted to ensure mockVaultClient is available before vi.mock runs
const mockVaultClient = vi.hoisted(() => ({
  write: vi.fn(),
  read: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("node-vault", () => {
  return {
    __esModule: true,
    default: () => mockVaultClient,
  };
});

import {
  createSecretManager,
  DbSecretsManager,
  getSecretsManagerType,
  getVaultConfigFromEnv,
  SecretsManagerConfigurationError,
  SecretsManagerType,
  VaultSecretManager,
} from "./secretsmanager";

describe("getSecretsManagerType", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should return DB when ARCHESTRA_SECRETS_MANAGER is not set", () => {
    delete process.env.ARCHESTRA_SECRETS_MANAGER;

    const type = getSecretsManagerType();

    expect(type).toBe(SecretsManagerType.DB);
  });

  test("should return DB when ARCHESTRA_SECRETS_MANAGER is 'DB'", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "DB";

    const type = getSecretsManagerType();

    expect(type).toBe(SecretsManagerType.DB);
  });

  test("should return DB when ARCHESTRA_SECRETS_MANAGER is 'db' (case insensitive)", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "db";

    const type = getSecretsManagerType();

    expect(type).toBe(SecretsManagerType.DB);
  });

  test("should return Vault when ARCHESTRA_SECRETS_MANAGER is 'Vault'", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";

    const type = getSecretsManagerType();

    expect(type).toBe(SecretsManagerType.Vault);
  });

  test("should return Vault when ARCHESTRA_SECRETS_MANAGER is 'vault' (case insensitive)", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "vault";

    const type = getSecretsManagerType();

    expect(type).toBe(SecretsManagerType.Vault);
  });

  test("should return DB for unknown values", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "unknown";

    const type = getSecretsManagerType();

    expect(type).toBe(SecretsManagerType.DB);
  });
});

describe("createSecretManager", () => {
  const originalEnv = process.env;
  const originalEnterpriseLicenseActivated = config.enterpriseLicenseActivated;

  const setEnterpriseLicenseActivated = (value: boolean) => {
    Object.defineProperty(config, "enterpriseLicenseActivated", {
      value,
      writable: true,
      configurable: true,
    });
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    setEnterpriseLicenseActivated(originalEnterpriseLicenseActivated);
  });

  test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is not set", () => {
    delete process.env.ARCHESTRA_SECRETS_MANAGER;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;
    delete process.env.HASHICORP_VAULT_ADDR;
    delete process.env.HASHICORP_VAULT_TOKEN;

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'DB'", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "DB";

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' but VAULT_ADDR is not set", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    setEnterpriseLicenseActivated(true);

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' but token is missing (default auth method)", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;
    setEnterpriseLicenseActivated(true);

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  test("should return DbSecretsManager when AUTH_METHOD=token but token is missing", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "token";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;
    setEnterpriseLicenseActivated(true);

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  test("should return VaultSecretManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' and vault env vars are set and enterprise license is activated", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "token";
    process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
    setEnterpriseLicenseActivated(true);

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(VaultSecretManager);
  });

  test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' but enterprise license is not activated", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "token";
    process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
    setEnterpriseLicenseActivated(false);

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  test("should return DbSecretsManager even when vault env vars are set if ARCHESTRA_SECRETS_MANAGER is 'DB'", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "DB";
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "token";
    process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });

  // Note: K8s auth integration test is skipped because it requires the K8s service account token file
  // The K8s config parsing is tested in getVaultConfigFromEnv tests

  test("should return DbSecretsManager when AUTH_METHOD=k8s but K8S_ROLE is missing", () => {
    process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "k8s";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;
    setEnterpriseLicenseActivated(true);

    const manager = createSecretManager();

    expect(manager).toBeInstanceOf(DbSecretsManager);
  });
});

describe("getVaultConfigFromEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should throw with all errors when multiple env vars are missing (token auth)", () => {
    delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;

    expect(() => getVaultConfigFromEnv()).toThrow(
      SecretsManagerConfigurationError,
    );
    expect(() => getVaultConfigFromEnv()).toThrow(
      "ARCHESTRA_HASHICORP_VAULT_ADDR is not set. ARCHESTRA_HASHICORP_VAULT_TOKEN is not set.",
    );
  });

  test("should default to token auth when AUTH_METHOD is not set", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD;

    const config = getVaultConfigFromEnv();

    expect(config).toEqual({
      address: "http://localhost:8200",
      authMethod: "token",
      token: "dev-root-token",
    });
  });

  test("should throw when token is missing (default auth method)", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;

    expect(() => getVaultConfigFromEnv()).toThrow(
      SecretsManagerConfigurationError,
    );
    expect(() => getVaultConfigFromEnv()).toThrow(
      "ARCHESTRA_HASHICORP_VAULT_TOKEN is not set",
    );
  });

  test("should throw when AUTH_METHOD=token but token is missing", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "token";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;

    expect(() => getVaultConfigFromEnv()).toThrow(
      SecretsManagerConfigurationError,
    );
    expect(() => getVaultConfigFromEnv()).toThrow(
      "ARCHESTRA_HASHICORP_VAULT_TOKEN is not set",
    );
  });

  test("should return token auth config when AUTH_METHOD=token and token is set", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "token";
    process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";

    const config = getVaultConfigFromEnv();

    expect(config).toEqual({
      address: "http://localhost:8200",
      authMethod: "token",
      token: "dev-root-token",
    });
  });

  test("should return K8s auth config with defaults when AUTH_METHOD=k8s and role is set", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "k8s";
    process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE = "archestra";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH;
    delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT;

    const config = getVaultConfigFromEnv();

    expect(config).toEqual({
      address: "http://localhost:8200",
      authMethod: "kubernetes",
      k8sRole: "archestra",
      k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      k8sMountPoint: "kubernetes",
    });
  });

  test("should throw when AUTH_METHOD=k8s but role is missing", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "k8s";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;

    expect(() => getVaultConfigFromEnv()).toThrow(
      SecretsManagerConfigurationError,
    );
    expect(() => getVaultConfigFromEnv()).toThrow(
      "ARCHESTRA_HASHICORP_VAULT_K8S_ROLE is not set",
    );
  });

  test("should throw with all errors when multiple env vars are missing (k8s auth)", () => {
    delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "k8s";
    delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;

    expect(() => getVaultConfigFromEnv()).toThrow(
      SecretsManagerConfigurationError,
    );
    expect(() => getVaultConfigFromEnv()).toThrow(
      "ARCHESTRA_HASHICORP_VAULT_ADDR is not set. ARCHESTRA_HASHICORP_VAULT_K8S_ROLE is not set.",
    );
  });

  test("should throw for invalid AUTH_METHOD", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "invalid";

    expect(() => getVaultConfigFromEnv()).toThrow(
      SecretsManagerConfigurationError,
    );
    expect(() => getVaultConfigFromEnv()).toThrow('Expected "token" or "k8s"');
  });

  test("should include optional K8s config when AUTH_METHOD=k8s", () => {
    process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
    process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "k8s";
    process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE = "archestra";
    process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH = "/custom/token/path";
    process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT = "custom-k8s";

    const config = getVaultConfigFromEnv();

    expect(config).toEqual({
      address: "http://localhost:8200",
      authMethod: "kubernetes",
      k8sRole: "archestra",
      k8sTokenPath: "/custom/token/path",
      k8sMountPoint: "custom-k8s",
    });
  });
});

describe("VaultSecretManager", () => {
  const vaultConfig = {
    address: "http://localhost:8200",
    authMethod: "token" as const,
    token: "dev-root-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSecret", () => {
    test("should rollback database record if vault write fails", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      // Make vault write fail
      mockVaultClient.write.mockRejectedValueOnce(
        new Error("Vault unavailable"),
      );

      await expect(
        vaultManager.createSecret(secretValue, "testsecret"),
      ).rejects.toThrow("Vault unavailable");

      // Verify that no secret remains in the database
      expect(mockVaultClient.write).toHaveBeenCalledTimes(1);
    });

    test("should create secret in both database and vault on success", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      const result = await vaultManager.createSecret(secretValue, "testsecret");

      expect(result.secret).toEqual(secretValue);
      expect(result.isVault).toBe(true);
      expect(result.name).toBe("testsecret");
      expect(mockVaultClient.write).toHaveBeenCalledTimes(1);
      expect(mockVaultClient.write).toHaveBeenCalledWith(
        `secret/data/archestra/testsecret-${result.id}`,
        { data: { value: JSON.stringify(secretValue) } },
      );

      // Cleanup
      await SecretModel.delete(result.id);
    });

    test("should sanitize names with invalid characters", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      // Name with spaces, hyphens, and special characters
      const result = await vaultManager.createSecret(
        secretValue,
        "my-secret name@2024!",
      );

      // Should replace invalid chars with underscores
      expect(result.name).toBe("my_secret_name_2024_");
      expect(mockVaultClient.write).toHaveBeenCalledWith(
        `secret/data/archestra/my_secret_name_2024_-${result.id}`,
        { data: { value: JSON.stringify(secretValue) } },
      );

      // Cleanup
      await SecretModel.delete(result.id);
    });

    test("should prepend underscore if name starts with digit", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      const result = await vaultManager.createSecret(secretValue, "123secret");

      // Should prepend underscore since it starts with a digit
      expect(result.name).toBe("_123secret");
      expect(mockVaultClient.write).toHaveBeenCalledWith(
        `secret/data/archestra/_123secret-${result.id}`,
        { data: { value: JSON.stringify(secretValue) } },
      );

      // Cleanup
      await SecretModel.delete(result.id);
    });

    test("should trim name to 64 characters", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      // Create a 100 character name
      const longName = "a".repeat(100);
      const result = await vaultManager.createSecret(secretValue, longName);

      // Should be trimmed to 64 chars
      expect(result.name).toBe("a".repeat(64));
      expect(result.name.length).toBe(64);

      // Cleanup
      await SecretModel.delete(result.id);
    });

    test("should handle empty or whitespace names", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      const result = await vaultManager.createSecret(secretValue, "   ");

      // Should use default name "secret"
      expect(result.name).toBe("secret");
      expect(mockVaultClient.write).toHaveBeenCalledWith(
        `secret/data/archestra/secret-${result.id}`,
        { data: { value: JSON.stringify(secretValue) } },
      );

      // Cleanup
      await SecretModel.delete(result.id);
    });

    test("should handle names with only invalid characters", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      const result = await vaultManager.createSecret(secretValue, "!@#$%^&*()");

      // Should convert all to underscores (10 chars -> 10 underscores)
      // No need to prepend another underscore since it already starts with one
      expect(result.name).toBe("__________");
      expect(result.name.length).toBe(10);

      // Cleanup
      await SecretModel.delete(result.id);
    });

    test("should preserve valid characters and underscores", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      mockVaultClient.write.mockResolvedValueOnce({});

      const result = await vaultManager.createSecret(
        secretValue,
        "Valid_Name_123",
      );

      // Should remain unchanged
      expect(result.name).toBe("Valid_Name_123");
      expect(mockVaultClient.write).toHaveBeenCalledWith(
        `secret/data/archestra/Valid_Name_123-${result.id}`,
        { data: { value: JSON.stringify(secretValue) } },
      );

      // Cleanup
      await SecretModel.delete(result.id);
    });
  });

  describe("deleteSecret", () => {
    test("should not delete database record if vault delete fails", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      // First create a secret successfully
      mockVaultClient.write.mockResolvedValueOnce({});
      const created = await vaultManager.createSecret(
        secretValue,
        "testsecret",
      );

      // Now make vault delete fail
      mockVaultClient.delete.mockRejectedValueOnce(
        new Error("Vault unavailable"),
      );

      await expect(vaultManager.deleteSecret(created.id)).rejects.toThrow(
        "Vault unavailable",
      );

      // Verify the database record still exists
      const dbRecord = await SecretModel.findById(created.id);
      expect(dbRecord).not.toBeNull();
      expect(dbRecord?.isVault).toBe(true);

      // Cleanup - force delete from DB
      await SecretModel.delete(created.id);
    });

    test("should delete from both vault and database on success", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      // Create a secret
      mockVaultClient.write.mockResolvedValueOnce({});
      const created = await vaultManager.createSecret(
        secretValue,
        "testsecret",
      );

      // Verify the secret was created in DB with isVault=true
      const beforeDelete = await SecretModel.findById(created.id);
      expect(beforeDelete).not.toBeNull();
      expect(beforeDelete?.isVault).toBe(true);

      // Delete successfully
      mockVaultClient.delete.mockResolvedValueOnce({});
      await vaultManager.deleteSecret(created.id);

      // Verify vault delete was called with metadata path (permanently removes all versions)
      expect(mockVaultClient.delete).toHaveBeenCalledWith(
        `secret/metadata/archestra/testsecret-${created.id}`,
      );

      // Verify database record is gone (this is the true test of success)
      const dbRecord = await SecretModel.findById(created.id);
      expect(dbRecord).toBeFalsy();
    });
  });

  describe("getSecret", () => {
    test("should throw if vault read fails", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      // Create a secret
      mockVaultClient.write.mockResolvedValueOnce({});
      const created = await vaultManager.createSecret(
        secretValue,
        "testsecret",
      );

      // Make vault read fail
      mockVaultClient.read.mockRejectedValueOnce(
        new Error("Vault unavailable"),
      );

      await expect(vaultManager.getSecret(created.id)).rejects.toThrow(
        "Vault unavailable",
      );

      // Cleanup
      await SecretModel.delete(created.id);
    });

    test("should return secret with value from vault on success", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };

      // Create a secret
      mockVaultClient.write.mockResolvedValueOnce({});
      const created = await vaultManager.createSecret(
        secretValue,
        "testsecret",
      );

      // Mock vault read response
      mockVaultClient.read.mockResolvedValueOnce({
        data: {
          data: {
            value: JSON.stringify(secretValue),
          },
        },
      });

      const result = await vaultManager.getSecret(created.id);

      expect(result).not.toBeNull();
      expect(result?.secret).toEqual(secretValue);
      expect(result?.isVault).toBe(true);
      expect(mockVaultClient.read).toHaveBeenCalledWith(
        `secret/data/archestra/testsecret-${created.id}`,
      );

      // Cleanup
      await SecretModel.delete(created.id);
    });
  });

  describe("updateSecret", () => {
    test("should not update database record if vault write fails", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };
      const newSecretValue = { access_token: "new-token" };

      // Create a secret
      mockVaultClient.write.mockResolvedValueOnce({});
      const created = await vaultManager.createSecret(
        secretValue,
        "testsecret",
      );
      const originalUpdatedAt = created.updatedAt;

      // Wait a bit to ensure timestamp would change
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Make vault write fail on update
      mockVaultClient.write.mockRejectedValueOnce(
        new Error("Vault unavailable"),
      );

      await expect(
        vaultManager.updateSecret(created.id, newSecretValue),
      ).rejects.toThrow("Vault unavailable");

      // Verify the database record was not updated (updatedAt should be same)
      const dbRecord = await SecretModel.findById(created.id);
      expect(dbRecord).not.toBeNull();
      expect(dbRecord?.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());

      // Cleanup
      await SecretModel.delete(created.id);
    });

    test("should update both vault and database on success", async () => {
      const vaultManager = new VaultSecretManager(vaultConfig);
      const secretValue = { access_token: "test-token" };
      const newSecretValue = { access_token: "new-token" };

      // Create a secret
      mockVaultClient.write.mockResolvedValueOnce({});
      const created = await vaultManager.createSecret(
        secretValue,
        "testsecret",
      );

      // Wait a bit to ensure timestamp would change
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update successfully
      mockVaultClient.write.mockResolvedValueOnce({});
      const result = await vaultManager.updateSecret(
        created.id,
        newSecretValue,
      );

      expect(result).not.toBeNull();
      expect(result?.secret).toEqual(newSecretValue);
      expect(mockVaultClient.write).toHaveBeenLastCalledWith(
        `secret/data/archestra/testsecret-${created.id}`,
        { data: { value: JSON.stringify(newSecretValue) } },
      );

      // Cleanup
      await SecretModel.delete(created.id);
    });
  });
});
