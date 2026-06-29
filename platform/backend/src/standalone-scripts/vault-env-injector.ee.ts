// biome-ignore-all lint/suspicious/noConsole: standalone script uses console for logging
/**
 * Vault Environment Injector
 *
 * Standalone init-container script that fetches secrets from HashiCorp Vault
 * and writes them as shell-sourceable KEY=VALUE pairs to /vault/secrets/env.
 *
 * Reuses VaultClient for Vault authentication (TOKEN, K8S, AWS)
 * and secret retrieval (KV v1/v2, K8s token refresh).
 *
 * Usage:
 *   VAULT_INJECTOR_SECRETS='[{"envVar":"DB_URL","path":"secret/data/db","key":"url"}]' \
 *   ARCHESTRA_HASHICORP_VAULT_ADDR=http://vault:8200 \
 *   ARCHESTRA_HASHICORP_VAULT_TOKEN=s.xxx \
 *   node dist/standalone-scripts/vault-env-injector.ee.mjs
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VaultClient } from "../secrets-manager/vault-client.ee";
import { getVaultConfigFromEnv } from "../secrets-manager/vault-config";

interface SecretSpec {
  envVar: string;
  path: string;
  key: string;
}

/**
 * Escape a value for safe use inside single-quoted shell assignment.
 * Wraps in single quotes and escapes embedded single quotes using the
 * standard shell idiom: ' → '"'"'
 */
export function escapeForShell(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

async function main() {
  const secretsJson = process.env.VAULT_INJECTOR_SECRETS;
  if (!secretsJson) {
    throw new Error("VAULT_INJECTOR_SECRETS environment variable is not set");
  }

  let secrets: SecretSpec[];
  try {
    secrets = JSON.parse(secretsJson);
  } catch {
    throw new Error(`VAULT_INJECTOR_SECRETS is not valid JSON: ${secretsJson}`);
  }

  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new Error("VAULT_INJECTOR_SECRETS must be a non-empty JSON array");
  }

  for (const spec of secrets) {
    if (!spec.envVar || !spec.path || !spec.key) {
      throw new Error(
        `Each secret must have envVar, path, and key. Got: ${JSON.stringify(spec)}`,
      );
    }
  }

  const vaultConfig = getVaultConfigFromEnv();
  const manager = new VaultClient(vaultConfig);

  console.log(
    `Fetching ${secrets.length} secret(s) from Vault at ${vaultConfig.address} (auth: ${vaultConfig.authMethod})...`,
  );

  const lines: string[] = [];

  for (const { envVar, path, key } of secrets) {
    console.log(`  ${envVar} ← ${path}#${key}`);
    const data = await manager.getSecretFromPath(path);
    const value = data[key];
    if (value === undefined) {
      throw new Error(
        `Key "${key}" not found at path "${path}". Available keys: ${Object.keys(data).join(", ")}`,
      );
    }
    lines.push(`${envVar}=${escapeForShell(value)}`);
  }

  writeFileSync("/vault/secrets/env", `${lines.join("\n")}\n`);
  console.log(`Wrote ${lines.length} secret(s) to /vault/secrets/env`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("vault-env-injector failed:", err.message || err);
    process.exit(1);
  });
}
