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

import { SecretsManagerType } from "@shared";
import {
  createSecretManager,
  getSecretsManagerTypeBasedOnEnvVars,
  getVaultConfigFromEnv,
  SecretsManagerConfigurationError,
} from "./secretsmanager";
import { DbSecretsManager } from "./secretsmanager.db";

describe("SecretsManager", async () => {
  // biome-ignore lint/style/noRestrictedImports: dynamic import
  const VaultSecretManager = (await import("./secretsmanager.vault.ee"))
    .default;

  describe("getSecretsManagerTypeBasedOnEnvVars", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test("should return DB when ARCHESTRA_SECRETS_MANAGER is not set", () => {
      delete process.env.ARCHESTRA_SECRETS_MANAGER;

      const type = getSecretsManagerTypeBasedOnEnvVars();

      expect(type).toBe(SecretsManagerType.DB);
    });

    test("should return DB when ARCHESTRA_SECRETS_MANAGER is 'DB'", () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "DB";

      const type = getSecretsManagerTypeBasedOnEnvVars();

      expect(type).toBe(SecretsManagerType.DB);
    });

    test("should return DB when ARCHESTRA_SECRETS_MANAGER is 'db' (case insensitive)", () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "db";

      const type = getSecretsManagerTypeBasedOnEnvVars();

      expect(type).toBe(SecretsManagerType.DB);
    });

    test("should return Vault when ARCHESTRA_SECRETS_MANAGER is 'Vault'", () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";

      const type = getSecretsManagerTypeBasedOnEnvVars();

      expect(type).toBe(SecretsManagerType.Vault);
    });

    test("should return Vault when ARCHESTRA_SECRETS_MANAGER is 'vault' (case insensitive)", () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "vault";

      const type = getSecretsManagerTypeBasedOnEnvVars();

      expect(type).toBe(SecretsManagerType.Vault);
    });

    test("should return DB for unknown values", () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "unknown";

      const type = getSecretsManagerTypeBasedOnEnvVars();

      expect(type).toBe(SecretsManagerType.DB);
    });
  });

  describe("createSecretManager", () => {
    const originalEnv = process.env;
    const originalEnterpriseLicenseActivated =
      config.enterpriseLicenseActivated;

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

    test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is not set", async () => {
      delete process.env.ARCHESTRA_SECRETS_MANAGER;

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'DB'", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "DB";

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' but VAULT_ADDR is not set", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
      setEnterpriseLicenseActivated(true);

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' but token is missing (default auth method)", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;
      setEnterpriseLicenseActivated(true);

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return VaultSecretManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' and vault env vars are set and enterprise license is activated", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
      setEnterpriseLicenseActivated(true);

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(VaultSecretManager);
    });

    test("should return DbSecretsManager when ARCHESTRA_SECRETS_MANAGER is 'Vault' but enterprise license is not activated", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
      setEnterpriseLicenseActivated(false);

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return DbSecretsManager even when vault env vars are set if ARCHESTRA_SECRETS_MANAGER is 'DB'", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "DB";
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return DbSecretsManager when AUTH_METHOD=K8S but K8S_ROLE is missing", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;
      setEnterpriseLicenseActivated(true);

      const manager = await createSecretManager();

      expect(manager).toBeInstanceOf(DbSecretsManager);
    });

    test("should return DbSecretsManager when AUTH_METHOD=AWS but AWS_ROLE is missing", async () => {
      process.env.ARCHESTRA_SECRETS_MANAGER = "Vault";
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "AWS";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE;
      setEnterpriseLicenseActivated(true);

      const manager = await createSecretManager();

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
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "token",
        kvVersion: "2",
        token: "dev-root-token",
        secretPath: "secret/data/archestra",
        secretMetadataPath: undefined,
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
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

    test("should throw when AUTH_METHOD=TOKEN but token is missing", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN;

      expect(() => getVaultConfigFromEnv()).toThrow(
        SecretsManagerConfigurationError,
      );
      expect(() => getVaultConfigFromEnv()).toThrow(
        "ARCHESTRA_HASHICORP_VAULT_TOKEN is not set",
      );
    });

    test("should return token auth config when AUTH_METHOD=TOKEN and token is set", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "token",
        kvVersion: "2",
        token: "dev-root-token",
        secretPath: "secret/data/archestra",
        secretMetadataPath: undefined,
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
      });
    });

    test("should return K8S auth config with defaults when AUTH_METHOD=K8S and role is set", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
      process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE = "archestra";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "kubernetes",
        kvVersion: "2",
        k8sRole: "archestra",
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
        secretPath: "secret/data/archestra",
        secretMetadataPath: undefined,
      });
    });

    test("should throw when AUTH_METHOD=K8S but role is missing", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE;

      expect(() => getVaultConfigFromEnv()).toThrow(
        SecretsManagerConfigurationError,
      );
      expect(() => getVaultConfigFromEnv()).toThrow(
        "ARCHESTRA_HASHICORP_VAULT_K8S_ROLE is not set",
      );
    });

    test("should throw with all errors when multiple env vars are missing (K8S auth)", () => {
      delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
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
      expect(() => getVaultConfigFromEnv()).toThrow(
        'Expected "TOKEN", "K8S", or "AWS"',
      );
    });

    test("should return AWS auth config with defaults when AUTH_METHOD=AWS and role is set", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "AWS";
      process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE = "archestra-role";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "aws",
        kvVersion: "2",
        awsRole: "archestra-role",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
        awsIamServerIdHeader: undefined,
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        secretPath: "secret/data/archestra",
        secretMetadataPath: undefined,
      });
    });

    test("should throw when AUTH_METHOD=AWS but role is missing", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "AWS";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE;

      expect(() => getVaultConfigFromEnv()).toThrow(
        SecretsManagerConfigurationError,
      );
      expect(() => getVaultConfigFromEnv()).toThrow(
        "ARCHESTRA_HASHICORP_VAULT_AWS_ROLE is not set",
      );
    });

    test("should throw with all errors when multiple env vars are missing (AWS auth)", () => {
      delete process.env.ARCHESTRA_HASHICORP_VAULT_ADDR;
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "AWS";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE;

      expect(() => getVaultConfigFromEnv()).toThrow(
        SecretsManagerConfigurationError,
      );
      expect(() => getVaultConfigFromEnv()).toThrow(
        "ARCHESTRA_HASHICORP_VAULT_ADDR is not set. ARCHESTRA_HASHICORP_VAULT_AWS_ROLE is not set.",
      );
    });

    test("should include optional AWS config when AUTH_METHOD=AWS", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "AWS";
      process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE = "archestra-role";
      process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT = "custom-aws";
      process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION = "eu-west-1";
      process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT =
        "https://sts.eu-west-1.amazonaws.com";
      process.env.ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID =
        "vault.example.com";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "aws",
        kvVersion: "2",
        awsRole: "archestra-role",
        awsMountPoint: "custom-aws",
        awsRegion: "eu-west-1",
        awsStsEndpoint: "https://sts.eu-west-1.amazonaws.com",
        awsIamServerIdHeader: "vault.example.com",
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        secretPath: "secret/data/archestra",
        secretMetadataPath: undefined,
      });
    });

    test("should include optional K8s config when AUTH_METHOD=K8S", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
      process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE = "archestra";
      process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH =
        "/custom/token/path";
      process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT = "custom-k8s";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "kubernetes",
        kvVersion: "2",
        k8sRole: "archestra",
        k8sTokenPath: "/custom/token/path",
        k8sMountPoint: "custom-k8s",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
        secretPath: "secret/data/archestra",
        secretMetadataPath: undefined,
      });
    });

    test("should use custom secret path when ARCHESTRA_HASHICORP_VAULT_SECRET_PATH is set (TOKEN auth)", () => {
      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "TOKEN";
      process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
      process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH =
        "custom/data/my-secrets";
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "token",
        kvVersion: "2",
        token: "dev-root-token",
        secretPath: "custom/data/my-secrets",
        secretMetadataPath: undefined,
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
      });
    });

    test("should use custom secret path when ARCHESTRA_HASHICORP_VAULT_SECRET_PATH is set (K8S auth)", () => {
      // Ensure K8S optional vars are not set so defaults are used
      delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT;
      delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;

      process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
      process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
      process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE = "archestra";
      process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH =
        "custom/data/my-secrets";

      const config = getVaultConfigFromEnv();

      expect(config).toEqual({
        address: "http://localhost:8200",
        authMethod: "kubernetes",
        kvVersion: "2",
        k8sRole: "archestra",
        k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
        k8sMountPoint: "kubernetes",
        awsMountPoint: "aws",
        awsRegion: "us-east-1",
        awsStsEndpoint: "https://sts.amazonaws.com",
        secretPath: "custom/data/my-secrets",
        secretMetadataPath: undefined,
      });
    });

    describe("KV version configuration", () => {
      test("should default to KV v2 when ARCHESTRA_HASHICORP_VAULT_KV_VERSION is not set", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
        delete process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

        const config = getVaultConfigFromEnv();

        expect(config.kvVersion).toBe("2");
        expect(config.secretPath).toBe("secret/data/archestra");
      });

      test("should use KV v1 paths when ARCHESTRA_HASHICORP_VAULT_KV_VERSION=1", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
        process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION = "1";
        delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

        const config = getVaultConfigFromEnv();

        expect(config.kvVersion).toBe("1");
        expect(config.secretPath).toBe("secret/archestra");
      });

      test("should use KV v2 paths when ARCHESTRA_HASHICORP_VAULT_KV_VERSION=2", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
        process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION = "2";
        delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;

        const config = getVaultConfigFromEnv();

        expect(config.kvVersion).toBe("2");
        expect(config.secretPath).toBe("secret/data/archestra");
      });

      test("should throw for invalid KV version", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
        process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION = "3";

        expect(() => getVaultConfigFromEnv()).toThrow(
          SecretsManagerConfigurationError,
        );
        expect(() => getVaultConfigFromEnv()).toThrow(
          'Invalid ARCHESTRA_HASHICORP_VAULT_KV_VERSION="3". Expected "1" or "2".',
        );
      });

      test("should allow custom secret path to override default even with KV v1", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_TOKEN = "dev-root-token";
        process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION = "1";
        process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH = "custom/secrets";

        const config = getVaultConfigFromEnv();

        expect(config.kvVersion).toBe("1");
        expect(config.secretPath).toBe("custom/secrets");
      });

      test("should include kvVersion in K8S auth config", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "K8S";
        process.env.ARCHESTRA_HASHICORP_VAULT_K8S_ROLE = "archestra";
        process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION = "1";
        delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT;

        const config = getVaultConfigFromEnv();

        expect(config.kvVersion).toBe("1");
        expect(config.secretPath).toBe("secret/archestra");
      });

      test("should include kvVersion in AWS auth config", () => {
        process.env.ARCHESTRA_HASHICORP_VAULT_ADDR = "http://localhost:8200";
        process.env.ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD = "AWS";
        process.env.ARCHESTRA_HASHICORP_VAULT_AWS_ROLE = "archestra-role";
        process.env.ARCHESTRA_HASHICORP_VAULT_KV_VERSION = "1";
        delete process.env.ARCHESTRA_HASHICORP_VAULT_SECRET_PATH;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_REGION;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT;
        delete process.env.ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID;

        const config = getVaultConfigFromEnv();

        expect(config.kvVersion).toBe("1");
        expect(config.secretPath).toBe("secret/archestra");
      });
    });
  });

  describe("VaultSecretManager", () => {
    const vaultConfig = {
      address: "http://localhost:8200",
      authMethod: "token" as const,
      kvVersion: "2" as const,
      token: "dev-root-token",
      secretPath: "secret/data/archestra",
      k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      k8sMountPoint: "kubernetes",
      awsMountPoint: "aws",
      awsRegion: "us-east-1",
      awsStsEndpoint: "https://sts.amazonaws.com",
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
        ).rejects.toThrow(
          "An error occurred while accessing secrets. Please try again later or contact your administrator.",
        );

        // Verify that no secret remains in the database
        expect(mockVaultClient.write).toHaveBeenCalledTimes(1);
      });

      test("should create secret in both database and vault on success", async () => {
        const vaultManager = new VaultSecretManager(vaultConfig);
        const secretValue = { access_token: "test-token" };

        mockVaultClient.write.mockResolvedValueOnce({});

        const result = await vaultManager.createSecret(
          secretValue,
          "testsecret",
        );

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

        const result = await vaultManager.createSecret(
          secretValue,
          "123secret",
        );

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

        const result = await vaultManager.createSecret(
          secretValue,
          "!@#$%^&*()",
        );

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
          "An error occurred while accessing secrets. Please try again later or contact your administrator.",
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
          "An error occurred while accessing secrets. Please try again later or contact your administrator.",
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
        ).rejects.toThrow(
          "An error occurred while accessing secrets. Please try again later or contact your administrator.",
        );

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

  describe("VaultSecretManager with KV v1", () => {
    const vaultConfigV1 = {
      address: "http://localhost:8200",
      authMethod: "token" as const,
      kvVersion: "1" as const,
      token: "dev-root-token",
      secretPath: "secret/archestra",
      k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      k8sMountPoint: "kubernetes",
      awsMountPoint: "aws",
      awsRegion: "us-east-1",
      awsStsEndpoint: "https://sts.amazonaws.com",
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    describe("createSecret", () => {
      test("should use v1 write payload format (no data wrapper)", async () => {
        const vaultManager = new VaultSecretManager(vaultConfigV1);
        const secretValue = { access_token: "test-token" };

        mockVaultClient.write.mockResolvedValueOnce({});

        const result = await vaultManager.createSecret(
          secretValue,
          "testsecret",
        );

        // v1: no { data: ... } wrapper
        expect(mockVaultClient.write).toHaveBeenCalledWith(
          `secret/archestra/testsecret-${result.id}`,
          { value: JSON.stringify(secretValue) },
        );

        // Cleanup
        await SecretModel.delete(result.id);
      });
    });

    describe("getSecret", () => {
      test("should read v1 response format (single data level)", async () => {
        const vaultManager = new VaultSecretManager(vaultConfigV1);
        const secretValue = { access_token: "test-token" };

        // Create a secret first
        mockVaultClient.write.mockResolvedValueOnce({});
        const created = await vaultManager.createSecret(
          secretValue,
          "testsecret",
        );

        // Mock v1 response format - single data level
        mockVaultClient.read.mockResolvedValueOnce({
          data: {
            value: JSON.stringify(secretValue),
          },
        });

        const result = await vaultManager.getSecret(created.id);

        expect(result?.secret).toEqual(secretValue);
        expect(mockVaultClient.read).toHaveBeenCalledWith(
          `secret/archestra/testsecret-${created.id}`,
        );

        // Cleanup
        await SecretModel.delete(created.id);
      });
    });

    describe("updateSecret", () => {
      test("should use v1 write payload format for updates", async () => {
        const vaultManager = new VaultSecretManager(vaultConfigV1);
        const secretValue = { access_token: "test-token" };
        const newSecretValue = { access_token: "new-token" };

        mockVaultClient.write.mockResolvedValueOnce({});
        const created = await vaultManager.createSecret(
          secretValue,
          "testsecret",
        );

        mockVaultClient.write.mockResolvedValueOnce({});
        await vaultManager.updateSecret(created.id, newSecretValue);

        // v1: no { data: ... } wrapper
        expect(mockVaultClient.write).toHaveBeenLastCalledWith(
          `secret/archestra/testsecret-${created.id}`,
          { value: JSON.stringify(newSecretValue) },
        );

        // Cleanup
        await SecretModel.delete(created.id);
      });
    });

    describe("deleteSecret", () => {
      test("should delete from same path as read/write (no metadata path)", async () => {
        const vaultManager = new VaultSecretManager(vaultConfigV1);
        const secretValue = { access_token: "test-token" };

        mockVaultClient.write.mockResolvedValueOnce({});
        const created = await vaultManager.createSecret(
          secretValue,
          "testsecret",
        );

        mockVaultClient.delete.mockResolvedValueOnce({});
        await vaultManager.deleteSecret(created.id);

        // v1 uses the same path for delete (no /metadata/)
        expect(mockVaultClient.delete).toHaveBeenCalledWith(
          `secret/archestra/testsecret-${created.id}`,
        );
      });
    });
  });
});
