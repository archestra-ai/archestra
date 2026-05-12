// biome-ignore-all lint/suspicious/noConsole: standalone interactive script — uses console for TTY UX
/**
 * READONLY_VAULT → VAULT migration tool (interactive).
 *
 * Walks an operator through a four-phase migration that flips the `secret`
 * table from BYOS storage to Archestra-managed Vault storage, with a
 * transactional DB flip and a manual-recovery backup table.
 *
 * Run from the `backend/` directory:
 *
 *   tsx --tsconfig standalone-scripts.tsconfig.json \
 *     src/standalone-scripts/migrate-byos-to-vault/migrate.ee.ts [--status|--rollback]
 *
 * Modes:
 *   (no flag)    # default forward migration
 *   --status     # read-only diagnostic
 *   --rollback   # restore the secret table from the Phase 1 backup
 *
 * Phase 1 creates a backup table (`backup_secret_pre_vault_migration`) as a
 * recovery anchor. If something goes wrong, run `--rollback` to restore the
 * secret table from it (or restore by hand from the same SQL). The backup is
 * preserved across runs and is safe to drop only once the migration has
 * soaked successfully.
 *
 * Vault credentials: the script reads the standard
 * `ARCHESTRA_HASHICORP_VAULT_*` env vars (same ones the live platform uses).
 * Before running, the operator must ensure that the configured Vault token /
 * role has WRITE permission on `${ARCHESTRA_HASHICORP_VAULT_SECRET_PATH}/*`
 * — typically a different (write-enabled) token than the live read-only one.
 * The script's write/read/delete probe (Phase 0) verifies this up front.
 *
 * Optional:
 *   MIGRATION_BACKEND_URL      if set, Phase 4's C18 audit check hits
 *                              POST <url>/api/secrets/check-connectivity
 *                              to confirm the live backend can list secrets
 *                              in the new Vault under the new env config.
 *   MIGRATION_BACKEND_API_KEY  bearer-style API key for the above probe
 *                              (route is auth-protected).
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { SecretsManagerType } from "@shared";
import { eq, inArray, sql } from "drizzle-orm";
import config from "@/config";
import db, { initializeDatabase, schema } from "@/database";
import { getSecretsManagerTypeBasedOnEnvVars } from "@/secrets-manager";
import { VaultClient } from "@/secrets-manager/vault-client.ee";
import { getVaultConfigFromEnv } from "@/secrets-manager/vault-config";
import type { SecretValue, VaultConfig } from "@/types";
import { decryptSecretValue, isEncryptedSecret } from "@/utils/crypto";

// ============================================================
// Constants
// ============================================================

const BACKUP_TABLE = "backup_secret_pre_vault_migration";
const PROBE_KEY_BASE = "__archestra_migration_probe__";
const SECTION = "─".repeat(64);
const OK = "✅";
const FAIL = "❌";
const WARN = "⚠️ ";
const INFO = "ℹ️ ";

/**
 * Sanitize a secret name to conform to Vault naming rules.
 *
 * IMPORTANT: kept in sync with the runtime sanitizer in
 * `backend/src/secrets-manager/vault.ee.ts`. If that one changes, change this
 * one too — the migration must produce the same names that VaultSecretManager
 * will compute when reading rows back after the env-var flip.
 */
function sanitizeVaultSecretName(name: string): string {
  if (!name || name.trim().length === 0) {
    return "secret";
  }
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized.slice(0, 64);
}

/**
 * Tables that hold a foreign key to `secret.id`. Hardcoded (rather than
 * discovered via pg_constraint) so per-row reports can refer to dependents
 * with the same names operators see in the schema. Verified against
 * `backend/src/database/schemas/*.ts` — if a new FK is added, append it here.
 *
 * The script fails loudly on the first FK lookup if a table/column is wrong
 * (rather than silently reporting "no dependents"), so drift here surfaces
 * the next time someone runs the migration.
 */
const FK_TABLES: { table: string; column: string }[] = [
  { table: "mcp_server", column: "secret_id" },
  { table: "chat_api_keys", column: "secret_id" },
  { table: "internal_mcp_catalog", column: "client_secret_id" },
  { table: "internal_mcp_catalog", column: "local_config_secret_id" },
  { table: "knowledge_base_connectors", column: "secret_id" },
  { table: "team_token", column: "secret_id" },
  { table: "user_token", column: "secret_id" },
  { table: "virtual_api_keys", column: "secret_id" },
];

// ============================================================
// CLI
// ============================================================

type Mode = "migrate" | "status" | "rollback";

function parseMode(): Mode {
  const args = process.argv.slice(2);
  if (args.includes("--status")) return "status";
  if (args.includes("--rollback")) return "rollback";
  return "migrate";
}

const INVOCATION =
  "tsx --tsconfig standalone-scripts.tsconfig.json src/standalone-scripts/migrate-byos-to-vault/migrate.ee.ts";

function printWelcome(): void {
  console.log(`\n${SECTION}`);
  console.log(`  Welcome to the Archestra READONLY_VAULT -> VAULT migration`);
  console.log(SECTION);
  console.log(`
  This tool walks you through migrating the secrets from READONLY_VAULT
  (customer-Vault references) to Archestra-managed Vault storage.

  Five phases, with explicit confirmation between each one:

    Phase 0  Pre-flight checks (no writes anywhere)
    Phase 1  Snapshot the secret table + write values to Vault
    Phase 2  Atomic DB flip + env-var change
    Phase 4  Post-migration consistency audit (fail-loud)
    Phase 3  Soak guidance

  Phase 1's backup table (backup_secret_pre_vault_migration) is preserved
  across runs as a recovery anchor. If something goes wrong, re-run this
  script with --rollback to restore the secret table from it.
`);
}

// ============================================================
// TTY helpers
// ============================================================

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(`${question} [Y/n] `);
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return true;
  return !trimmed.startsWith("n");
}

async function pressEnter(message: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await rl.question(message);
  rl.close();
}

function printHeader(title: string): void {
  console.log(`\n${SECTION}`);
  console.log(`  ${title}`);
  console.log(SECTION);
}

function printCheck(passed: boolean, message: string, detail?: string): void {
  const mark = passed ? OK : FAIL;
  console.log(`  ${mark} ${message}${detail ? ` — ${detail}` : ""}`);
}

function printWarn(message: string, detail?: string): void {
  console.log(`  ${WARN} ${message}${detail ? ` — ${detail}` : ""}`);
}

function abort(message: string): never {
  console.error(`\n${FAIL} ${message}\n`);
  process.exit(1);
}

/**
 * Map the internal SecretsManagerType enum back to the user-facing
 * ARCHESTRA_SECRETS_MANAGER env-var value, so operators see the same
 * label they typed into their config (BYOS_VAULT is the internal name
 * for what the env-var calls READONLY_VAULT).
 */
function modeLabel(mode: SecretsManagerType): string {
  if (mode === SecretsManagerType.BYOS_VAULT) return "READONLY_VAULT";
  return mode;
}

// ============================================================
// Vault config — uses the standard ARCHESTRA_HASHICORP_VAULT_* env vars
// (same ones the live platform reads via getVaultConfigFromEnv). The
// operator must ensure the configured token / role has write permission
// on `${secretPath}/*` before running; the script's write/read/delete
// probe in Phase 0 verifies this.
// ============================================================

function printVaultEnvHelp(): void {
  console.log(`
This script reads the standard ARCHESTRA_HASHICORP_VAULT_* env vars.
Required:

  ARCHESTRA_HASHICORP_VAULT_ADDR        e.g. https://vault.internal:8200
  ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD TOKEN | K8S | AWS  (default TOKEN)

For TOKEN auth:
  ARCHESTRA_HASHICORP_VAULT_TOKEN       a token with create/read/update/delete on \${SECRET_PATH}/*

For K8S auth:
  ARCHESTRA_HASHICORP_VAULT_K8S_ROLE    Vault role bound to the K8s service account

For AWS auth:
  ARCHESTRA_HASHICORP_VAULT_AWS_ROLE    Vault role bound to the AWS IAM principal
`);
}

// ============================================================
// MigrationVaultClient
// Subclass of VaultClient that exposes the protected helpers as
// public methods so the migration logic can read/write/delete and
// build payloads identically to VaultSecretManager.
// ============================================================

class MigrationVaultClient extends VaultClient {
  async write(path: string, payload: Record<string, unknown>): Promise<void> {
    await this.writeToPath(path, payload);
  }

  async readOrNull(
    path: string,
  ): Promise<{ data: Record<string, unknown> } | null> {
    try {
      return await this.readFromPath(path);
    } catch (error) {
      const status = (error as { response?: { statusCode?: number } })?.response
        ?.statusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async deleteAt(path: string): Promise<void> {
    await this.deleteAtPath(path);
  }

  buildPayloadFor(value: string): Record<string, unknown> {
    return this.buildWritePayload({ value });
  }

  extractValueFrom(response: { data: Record<string, unknown> }): string {
    const data = this.extractSecretData(response);
    return data.value;
  }

  extractDataFrom(response: {
    data: Record<string, unknown>;
  }): Record<string, string> {
    return this.extractSecretData(response);
  }

  /**
   * For a write at `${secretPath}/${name}`, return the path used to
   * permanently delete it. KV v2 uses a separate metadata path.
   */
  metadataPathFor(path: string): string {
    if (this.config.kvVersion === "1") return path;
    return (
      this.config.secretMetadataPath ??
      this.config.secretPath.replace("/data/", "/metadata/")
    ).concat(path.slice(this.config.secretPath.length));
  }
}

// ============================================================
// State checks
// ============================================================

async function checkBackupTable(): Promise<{
  exists: boolean;
  rowCount?: number;
}> {
  const existsResult = await db.execute(
    sql`SELECT to_regclass(${`public.${BACKUP_TABLE}`}) AS reg`,
  );
  const reg = (existsResult.rows[0] as { reg: string | null }).reg;
  if (!reg) return { exists: false };

  const countResult = await db.execute(
    sql.raw(`SELECT count(*)::int AS c FROM "${BACKUP_TABLE}"`),
  );
  const rowCount = (countResult.rows[0] as { c: number }).c;
  return { exists: true, rowCount };
}

interface ByosRow {
  id: string;
  name: string;
  sanitizedName: string;
  /** archestraKey → "vault/path#vaultKey" reference (decrypted) */
  references: Record<string, string>;
}

async function inventoryByosRows(): Promise<ByosRow[]> {
  const rows = await db
    .select({
      id: schema.secretsTable.id,
      name: schema.secretsTable.name,
      secret: schema.secretsTable.secret,
    })
    .from(schema.secretsTable)
    .where(eq(schema.secretsTable.isByosVault, true));

  return rows.map((row) => {
    // The secret JSONB column is encrypted at rest; decrypt before reading
    // reference strings. Mirrors the runtime behavior of
    // `SecretModel.findById` in `backend/src/models/secret.ts`.
    const decrypted = isEncryptedSecret(row.secret)
      ? decryptSecretValue(row.secret as unknown as { __encrypted: string })
      : ((row.secret ?? {}) as Record<string, unknown>);

    const references: Record<string, string> = {};
    for (const [k, v] of Object.entries(decrypted)) {
      if (typeof v === "string") references[k] = v;
    }

    return {
      id: row.id,
      name: row.name,
      sanitizedName: sanitizeVaultSecretName(row.name),
      references,
    };
  });
}

/**
 * Resolve a BYOS row's references against the live customer Vault, in-process,
 * without going through `secretManager()`. This bypasses
 * `VaultClient.handleVaultError` and `BYOSVaultSecretManager.getSecret`'s
 * `logger.error` calls, so 404s on stale rows don't generate confusing log
 * noise. Mirrors the resolution logic of `ReadonlyVaultSecretManager.getSecret`
 * (`backend/src/secrets-manager/readonly-vault.ee.ts:106-182`) — keep in sync
 * if that changes.
 */
type ResolveResult =
  | { status: "resolved"; values: SecretValue }
  | { status: "stale"; reason: string }
  | { status: "fatal"; reason: string };

async function resolveByosRow(
  byosClient: MigrationVaultClient,
  row: ByosRow,
): Promise<ResolveResult> {
  if (Object.keys(row.references).length === 0) {
    return { status: "resolved", values: {} };
  }

  // Group references by Vault path so we read each path only once.
  const pathToKeys = new Map<
    string,
    { archestraKey: string; vaultKey: string }[]
  >();
  for (const [archestraKey, ref] of Object.entries(row.references)) {
    const hashIdx = ref.indexOf("#");
    if (hashIdx === -1) {
      return { status: "fatal", reason: `malformed reference: ${ref}` };
    }
    const path = ref.slice(0, hashIdx);
    const vaultKey = ref.slice(hashIdx + 1);
    const list = pathToKeys.get(path) ?? [];
    list.push({ archestraKey, vaultKey });
    pathToKeys.set(path, list);
  }

  const resolved: SecretValue = {};
  const missing: { archestraKey: string; ref: string; reason: string }[] = [];

  for (const [path, keys] of pathToKeys) {
    let response: { data: Record<string, unknown> } | null;
    try {
      response = await byosClient.readOrNull(path);
    } catch (e) {
      return {
        status: "fatal",
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    if (!response) {
      for (const { archestraKey, vaultKey } of keys) {
        missing.push({
          archestraKey,
          ref: `${path}#${vaultKey}`,
          reason: "path 404",
        });
      }
      continue;
    }
    const data = byosClient.extractDataFrom(response);
    for (const { archestraKey, vaultKey } of keys) {
      if (data[vaultKey] !== undefined) {
        resolved[archestraKey] = data[vaultKey];
      } else {
        missing.push({
          archestraKey,
          ref: `${path}#${vaultKey}`,
          reason: "key not found at path",
        });
      }
    }
  }

  if (missing.length > 0) {
    const summary = missing
      .map((m) => `${m.archestraKey} (${m.ref}: ${m.reason})`)
      .join("; ");
    return { status: "stale", reason: summary };
  }
  return { status: "resolved", values: resolved };
}

interface RowCounts {
  byos: number;
  vault: number;
  db: number;
}

async function getRowCounts(): Promise<RowCounts> {
  const result = await db.execute(sql`
    SELECT
      sum(CASE WHEN is_byos_vault THEN 1 ELSE 0 END)::int AS byos,
      sum(CASE WHEN is_vault THEN 1 ELSE 0 END)::int AS vault,
      sum(CASE WHEN NOT is_byos_vault AND NOT is_vault THEN 1 ELSE 0 END)::int AS dbcount
    FROM secret
  `);
  const row = result.rows[0] as {
    byos: number | null;
    vault: number | null;
    dbcount: number | null;
  };
  return {
    byos: row.byos ?? 0,
    vault: row.vault ?? 0,
    db: row.dbcount ?? 0,
  };
}

interface FkImpact {
  secretId: string;
  references: { table: string; column: string; count: number }[];
  total: number;
}

async function fkImpactReport(secretIds: string[]): Promise<FkImpact[]> {
  if (secretIds.length === 0) return [];

  const impactBySecretId = new Map<string, FkImpact>();
  for (const id of secretIds) {
    impactBySecretId.set(id, { secretId: id, references: [], total: 0 });
  }

  // Build a real uuid[] literal: Drizzle's `sql` template spreads JS arrays
  // into a row constructor `($1, $2)` rather than a single array param, so
  // `ANY(${arr}::uuid[])` is invalid syntax. `ARRAY[$1::uuid, $2::uuid, ...]`
  // via sql.join generates the correct array literal.
  const idsArrayLit = sql`ARRAY[${sql.join(
    secretIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;

  for (const { table, column } of FK_TABLES) {
    // No try/catch: if a table or column name in FK_TABLES is wrong, the
    // query throws and the migration aborts. That's intentional — silent
    // skipping would mask schema drift and falsely report "no dependents".
    const r = await db.execute(
      sql`
        SELECT ${sql.identifier(column)}::text AS sid, count(*)::int AS c
        FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(column)} = ANY(${idsArrayLit})
        GROUP BY ${sql.identifier(column)}
      `,
    );
    const rows = r.rows as { sid: string; c: number }[];
    for (const row of rows) {
      const impact = impactBySecretId.get(row.sid);
      if (!impact) continue;
      impact.references.push({ table, column, count: row.c });
      impact.total += row.c;
    }
  }

  return Array.from(impactBySecretId.values());
}

// ============================================================
// Phase 0 — Pre-flight
// ============================================================

/**
 * Captured at end of Phase 0 so Phase 4 can verify nothing changed
 * concurrently with the migration (external writers) and that FK consumers
 * still reference the same secrets they did at baseline.
 */
interface Phase0Snapshot {
  totalSecretCount: number;
  allSecretIds: Set<string>;
  maxSecretUpdatedAt: Date | null;
  // "<table>.<column>" → counts captured before Phase 1.
  fkBaseline: Map<string, { nonNullTotal: number; refsToMigratedSet: number }>;
  staleIds: Set<string>;
}

interface PreflightResult {
  rows: ByosRow[];
  resolvedValues: Map<string, SecretValue>;
  vaultClient: MigrationVaultClient;
  vaultConfig: VaultConfig;
  reuseExistingBackup: boolean;
  snapshot: Phase0Snapshot;
}

async function phase0Preflight(): Promise<PreflightResult> {
  printHeader("Phase 0 — Pre-flight checks");

  // 1. Mode
  const currentMode = getSecretsManagerTypeBasedOnEnvVars();
  const currentModeOk = currentMode === SecretsManagerType.BYOS_VAULT;
  printCheck(
    currentModeOk,
    "ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT",
    `current mode: ${modeLabel(currentMode)}`,
  );
  if (!currentModeOk) {
    abort(
      "Migration must run while READONLY_VAULT is the active mode. Set ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and re-run.",
    );
  }

  // 2. Enterprise license
  const eeOk = config.enterpriseFeatures.core;
  printCheck(eeOk, "Enterprise license active");
  if (!eeOk) {
    abort(
      "READONLY_VAULT and Vault modes require an active enterprise license.",
    );
  }

  // 3. DB connectivity
  try {
    await db.execute(sql`SELECT 1`);
    printCheck(true, "Database reachable");
  } catch (e) {
    printCheck(false, "Database reachable", String(e));
    abort("Database is not reachable.");
  }

  // 4. Inventory
  const counts = await getRowCounts();
  const rows = await inventoryByosRows();
  printCheck(
    true,
    "Inventory",
    `${counts.byos} READONLY_VAULT rows, ${counts.vault} Vault rows, ${counts.db} plain DB rows`,
  );
  for (const row of rows) {
    const renamed = row.sanitizedName !== row.name;
    const nameLabel = renamed
      ? `"${row.name}" → "${row.sanitizedName}"`
      : `"${row.sanitizedName}"`;
    const keys = Object.keys(row.references);
    console.log(
      `     • ${row.id} ${nameLabel} (${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")})`,
    );
  }

  if (rows.length === 0) {
    console.log(
      `\n${INFO} No is_byos_vault=true rows found. Nothing to migrate.`,
    );
    if (counts.vault > 0 || counts.db > 0) {
      console.log(
        `${INFO} Existing Vault/DB rows will continue to work after a flag flip without migration.`,
      );
    }
    process.exit(0);
  }

  // 5. Build the single Vault client from ARCHESTRA_HASHICORP_VAULT_*.
  //     Used to read existing BYOS references AND to write Archestra-managed
  //     entries during Phase 1. Bypasses secretManager()/handleVaultError so
  //     stale-row 404s don't trigger logger.error noise.
  let vaultConfig: VaultConfig;
  let vaultClient: MigrationVaultClient;
  try {
    vaultConfig = getVaultConfigFromEnv();
    vaultClient = new MigrationVaultClient(vaultConfig);
    printCheck(
      true,
      "Vault config",
      `${vaultConfig.address} (${vaultConfig.authMethod}, KV v${vaultConfig.kvVersion}, path=${vaultConfig.secretPath})`,
    );
  } catch (e) {
    printCheck(false, "Vault config", String(e));
    printVaultEnvHelp();
    abort(
      "Cannot read Vault config from ARCHESTRA_HASHICORP_VAULT_*. Set the env vars and re-run.",
    );
  }

  // 6. Live BYOS Vault probe (sample up to 5 rows; tolerate stale 404s,
  // abort on real connectivity errors)
  const probeMax = Math.min(5, rows.length);
  let probeResolved = false;
  let probeStaleCount = 0;
  let probeFatalMsg: string | undefined;
  for (let i = 0; i < probeMax; i++) {
    const result = await resolveByosRow(vaultClient, rows[i]);
    if (result.status === "resolved") {
      probeResolved = true;
      break;
    }
    if (result.status === "stale") {
      probeStaleCount++;
      continue;
    }
    probeFatalMsg = result.reason;
    break;
  }
  if (probeFatalMsg) {
    printCheck(false, "Vault read probe", probeFatalMsg);
    abort(
      "Vault is not reachable for reads (auth/network/5xx). Fix connectivity before migrating.",
    );
  }
  if (probeResolved) {
    printCheck(true, "Vault read probe");
  } else {
    printCheck(
      true,
      "Vault read probe",
      `${probeStaleCount}/${probeMax} sampled rows have stale references — full classification follows`,
    );
  }

  // 7. Vault write probe (synthetic key write/read/delete)
  const probeId = randomUUID();
  const probePath = `${vaultConfig.secretPath}/${PROBE_KEY_BASE}-${probeId}`;
  const probeValue = `probe-${probeId}-${Date.now()}`;
  try {
    await vaultClient.write(probePath, vaultClient.buildPayloadFor(probeValue));
    const readBack = await vaultClient.readOrNull(probePath);
    if (!readBack) throw new Error("readback returned null");
    const extracted = vaultClient.extractValueFrom(readBack);
    if (extracted !== probeValue) {
      throw new Error(
        `readback mismatch: wrote ${probeValue}, got ${extracted}`,
      );
    }
    const probeMetaPath = vaultClient.metadataPathFor(probePath);
    await vaultClient.deleteAt(probeMetaPath);
    printCheck(true, "Vault write probe (write/read/delete)");
  } catch (e) {
    printCheck(false, "Vault write probe", String(e));
    abort(
      "Vault write probe failed. The configured token / role needs create/read/update/delete on the secret path. Update ARCHESTRA_HASHICORP_VAULT_TOKEN (or the role) and re-run.",
    );
  }

  // 8. Backup-table check
  const backup = await checkBackupTable();
  let reuseExistingBackup = false;
  if (backup.exists) {
    console.log(
      `\n${WARN} Backup table "${BACKUP_TABLE}" already exists with ${backup.rowCount} rows.`,
    );
    console.log(
      `   This usually means a previous migration attempt was interrupted.`,
    );
    console.log(`   Options:`);
    console.log(`     • reuse the existing backup (idempotent re-run)`);
    console.log(`     • abort and investigate / drop the table manually`);
    const reuse = await confirm("Reuse the existing backup table?");
    if (!reuse) {
      console.log(
        `\n${INFO} Aborted. To start fresh: DROP TABLE ${BACKUP_TABLE};`,
      );
      process.exit(1);
    }
    reuseExistingBackup = true;
  } else {
    printCheck(true, "Backup table absent");
  }

  // 9. Sanitization conflict scan
  const sanitizedNameSet = new Map<string, string[]>();
  for (const row of rows) {
    const list = sanitizedNameSet.get(row.sanitizedName) ?? [];
    list.push(row.id);
    sanitizedNameSet.set(row.sanitizedName, list);
  }
  const renamedCount = rows.filter((r) => r.sanitizedName !== r.name).length;
  const collisions = Array.from(sanitizedNameSet.entries()).filter(
    ([, ids]) => ids.length > 1,
  );
  printCheck(
    true,
    "Sanitization preview",
    `${renamedCount}/${rows.length} rows will be renamed`,
  );
  if (collisions.length > 0) {
    console.log(
      `   ${WARN} ${collisions.length} sanitized name(s) shared by multiple rows`,
    );
    console.log(
      `      (paths still unique because row UUID is part of the path; FYI only)`,
    );
  }

  // 10. FK impact report
  const ids = rows.map((r) => r.id);
  const impacts = await fkImpactReport(ids);
  const totalRefs = impacts.reduce((sum, i) => sum + i.total, 0);
  printCheck(true, "FK impact scan", `${totalRefs} downstream references`);
  for (const row of rows) {
    const impact = impacts.find((i) => i.secretId === row.id);
    const summary =
      impact && impact.references.length > 0
        ? impact.references
            .map((r) => `${r.table}.${r.column}=${r.count}`)
            .join(", ")
        : "no dependents";
    console.log(`   • ${row.id} (${row.sanitizedName}): ${summary}`);
  }

  // 11. Resolution dress-rehearsal: classify each row.
  //   resolved → migratable
  //   stale    → skip (path/key gone in customer Vault, or partial resolution)
  //   fatal    → abort (real connectivity issue)
  const resolvedValues = new Map<string, SecretValue>();
  const migratableRows: ByosRow[] = [];
  const staleRows: { row: ByosRow; reason: string }[] = [];
  const fatalRows: { row: ByosRow; reason: string }[] = [];

  for (const row of rows) {
    const result = await resolveByosRow(vaultClient, row);
    if (result.status === "resolved") {
      resolvedValues.set(row.id, result.values);
      migratableRows.push(row);
    } else if (result.status === "stale") {
      staleRows.push({ row, reason: result.reason });
    } else {
      fatalRows.push({ row, reason: result.reason });
    }
  }

  printCheck(
    fatalRows.length === 0,
    "Resolution dress-rehearsal",
    `${migratableRows.length} migratable, ${staleRows.length} stale (skip), ${fatalRows.length} fatal`,
  );

  if (fatalRows.length > 0) {
    console.log(`\n   ${FAIL} Fatal resolution errors (cannot proceed):`);
    for (const { row, reason } of fatalRows) {
      console.log(`      • ${row.id} (${row.name}): ${reason}`);
    }
    abort("Fatal resolution errors detected. Fix Vault state, then re-run.");
  }

  if (staleRows.length > 0) {
    console.log(
      `\n   ${WARN} ${staleRows.length} row(s) with stale READONLY_VAULT references — these will be SKIPPED (not migrated, left untouched in DB):`,
    );
    let staleWithDeps = 0;
    for (const { row, reason } of staleRows) {
      const impact = impacts.find((i) => i.secretId === row.id);
      const depSummary =
        impact && impact.references.length > 0
          ? impact.references
              .map((r) => `${r.table}.${r.column}=${r.count}`)
              .join(", ")
          : "no dependents";
      if (impact && impact.total > 0) staleWithDeps++;
      console.log(
        `      • ${row.id} (${row.name}): ${reason} | deps: ${depSummary}`,
      );
    }
    if (staleWithDeps > 0) {
      console.log(
        `\n   ${WARN} ${staleWithDeps} stale row(s) HAVE downstream dependents.`,
      );
      console.log(
        `      Those dependents reference data the customer Vault no longer has;`,
      );
      console.log(
        `      they were already broken before this migration. Consider fixing them`,
      );
      console.log(`      separately, but it is not a blocker for migrating.`);
    }
    const proceed = await confirm(
      `Skip ${staleRows.length} stale row(s) and migrate the remaining ${migratableRows.length}?`,
    );
    if (!proceed) {
      console.log(`\n${INFO} Aborted by operator. No changes made.`);
      process.exit(0);
    }
  }

  if (migratableRows.length === 0) {
    abort(
      "No migratable rows after classification. Nothing to do (or every reference is stale).",
    );
  }

  // Phase 0 summary
  console.log(`\n${SECTION}`);
  console.log(`  Phase 0 summary`);
  console.log(SECTION);
  console.log(`  ${OK} All pre-flight checks passed`);
  console.log(
    `  ${INFO} Will migrate ${migratableRows.length} row${migratableRows.length === 1 ? "" : "s"}:`,
  );
  for (const row of migratableRows) {
    const impact = impacts.find((i) => i.secretId === row.id);
    const renamed = row.sanitizedName !== row.name;
    const nameLabel = renamed
      ? `"${row.name}" → "${row.sanitizedName}"`
      : `"${row.sanitizedName}"`;
    const keys = Object.keys(row.references).join(", ");
    const deps =
      impact && impact.references.length > 0
        ? impact.references
            .map((r) => `${r.table}.${r.column}=${r.count}`)
            .join(", ")
        : "no dependents";
    console.log(`     • ${row.id} ${nameLabel}`);
    console.log(`         keys: ${keys}`);
    console.log(`         deps: ${deps}`);
  }
  if (staleRows.length > 0) {
    console.log(
      `  ${WARN} Skipping ${staleRows.length} stale row${staleRows.length === 1 ? "" : "s"} (left untouched in DB)`,
    );
  }
  console.log(SECTION);

  console.log(`
  Next, Phase 1 prepares the migration without touching live state:

    1. Back up the secrets table.
    2. Write each secret into Vault and verify it reads back identically.

  The existing secrets table is not modified.
`);
  const cont = await confirm("Proceed with Phase 1?");
  if (!cont) {
    console.log(`\n${INFO} Aborted by operator. No changes made.`);
    process.exit(0);
  }

  // Capture the Phase 0 baseline so Phase 4 can detect external writes
  // and verify FK consumers haven't shifted.
  const snapshot = await captureSnapshot(
    new Set(migratableRows.map((r) => r.id)),
    new Set(staleRows.map((s) => s.row.id)),
  );

  return {
    rows: migratableRows,
    resolvedValues,
    vaultClient,
    vaultConfig,
    reuseExistingBackup,
    snapshot,
  };
}

async function captureSnapshot(
  migratedIds: Set<string>,
  staleIds: Set<string>,
): Promise<Phase0Snapshot> {
  const totals = await db.execute(sql`
    SELECT
      count(*)::int AS total,
      max(updated_at) AS max_updated_at
    FROM secret
  `);
  const { total, max_updated_at } = totals.rows[0] as {
    total: number;
    max_updated_at: Date | string | null;
  };

  const idsResult = await db.execute(sql`SELECT id::text AS id FROM secret`);
  const allSecretIds = new Set(
    (idsResult.rows as { id: string }[]).map((r) => r.id),
  );

  const fkBaseline = new Map<
    string,
    { nonNullTotal: number; refsToMigratedSet: number }
  >();
  const migratedArr = Array.from(migratedIds);
  const idsArrayLit =
    migratedArr.length > 0
      ? sql`ARRAY[${sql.join(
          migratedArr.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`
      : sql`ARRAY[]::uuid[]`;
  for (const { table, column } of FK_TABLES) {
    const r = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE ${sql.identifier(column)} IS NOT NULL)::int AS non_null_total,
        count(*) FILTER (WHERE ${sql.identifier(column)} = ANY(${idsArrayLit}))::int AS to_migrated
      FROM ${sql.identifier(table)}
    `);
    const { non_null_total, to_migrated } = r.rows[0] as {
      non_null_total: number;
      to_migrated: number;
    };
    fkBaseline.set(`${table}.${column}`, {
      nonNullTotal: non_null_total,
      refsToMigratedSet: to_migrated,
    });
  }

  return {
    totalSecretCount: total,
    allSecretIds,
    maxSecretUpdatedAt:
      max_updated_at instanceof Date
        ? max_updated_at
        : max_updated_at
          ? new Date(max_updated_at)
          : null,
    fkBaseline,
    staleIds,
  };
}

// ============================================================
// Phase 1 — Vault pre-stage + DB backup
// ============================================================

interface PrestagedRow extends ByosRow {
  vaultPath: string;
  resolvedValue: SecretValue;
}

async function phase1Prestage(
  preflight: PreflightResult,
): Promise<PrestagedRow[]> {
  printHeader("Phase 1 — Vault pre-stage + DB backup");

  // 1. Backup table
  if (!preflight.reuseExistingBackup) {
    console.log(`  Creating backup table "${BACKUP_TABLE}" ...`);
    await db.execute(
      sql.raw(
        `CREATE TABLE "${BACKUP_TABLE}" AS SELECT *, NOW() AS backed_up_at FROM secret`,
      ),
    );
    const r = await db.execute(
      sql.raw(`SELECT count(*)::int AS c FROM "${BACKUP_TABLE}"`),
    );
    const c = (r.rows[0] as { c: number }).c;
    printCheck(true, "Backup table created", `${c} rows`);
  } else {
    printCheck(true, "Reusing existing backup table");
  }

  // 2. Per-row Vault writes
  const { rows, resolvedValues, vaultClient, vaultConfig } = preflight;
  const prestaged: PrestagedRow[] = [];
  let writes = 0;
  let idempotent = 0;

  for (const row of rows) {
    const vaultPath = `${vaultConfig.secretPath}/${row.sanitizedName}-${row.id}`;
    const resolvedValue = resolvedValues.get(row.id);
    if (!resolvedValue) {
      printCheck(
        false,
        `${row.id}`,
        "no resolved value (Phase 0 inconsistency)",
      );
      abort("Internal error: missing resolved value for row.");
    }
    const expectedSerialized = JSON.stringify(resolvedValue);

    try {
      const existing = await vaultClient.readOrNull(vaultPath);
      if (existing) {
        const existingValue = vaultClient.extractValueFrom(existing);
        if (existingValue === expectedSerialized) {
          idempotent++;
          prestaged.push({ ...row, vaultPath, resolvedValue });
          const keyCount = Object.keys(resolvedValue).length;
          console.log(
            `   ${OK} ${row.sanitizedName} — already present at ${vaultPath} (${keyCount} key${keyCount === 1 ? "" : "s"}, idempotent)`,
          );
          continue;
        }
        printCheck(
          false,
          `${row.sanitizedName}`,
          `existing data at ${vaultPath} differs from what we'd write`,
        );
        abort(
          `Refusing to overwrite existing different data at ${vaultPath}. Investigate manually.`,
        );
      }

      await vaultClient.write(
        vaultPath,
        vaultClient.buildPayloadFor(expectedSerialized),
      );
      const readBack = await vaultClient.readOrNull(vaultPath);
      if (!readBack) {
        printCheck(false, `${row.sanitizedName}`, "readback returned null");
        abort(`Readback failed at ${vaultPath}.`);
      }
      const readValue = vaultClient.extractValueFrom(readBack);
      if (readValue !== expectedSerialized) {
        printCheck(
          false,
          `${row.sanitizedName}`,
          "readback bytes differ from written bytes",
        );
        abort(`Readback mismatch at ${vaultPath}.`);
      }
      writes++;
      prestaged.push({ ...row, vaultPath, resolvedValue });
      const keys = Object.keys(resolvedValue);
      console.log(
        `   ${OK} ${row.sanitizedName} → ${vaultPath} (${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")})`,
      );
    } catch (e) {
      printCheck(false, `${row.sanitizedName}`, String(e));
      abort(`Vault write/verify failed at ${vaultPath}: ${String(e)}`);
    }
  }

  // 3. Full re-verification using the future runtime read path.
  //    Reads every pre-staged path and confirms the parsed value still
  //    equals what we resolved in Phase 0 — i.e. it survives a full
  //    JSON serialize/deserialize round-trip the way VaultSecretManager
  //    will perform at runtime.
  let verifiedOk = 0;
  const verifyFailures: { row: PrestagedRow; reason: string }[] = [];
  for (const r of prestaged) {
    try {
      const response = await vaultClient.readOrNull(r.vaultPath);
      if (!response) throw new Error("not found");
      const value = JSON.parse(vaultClient.extractValueFrom(response));
      if (JSON.stringify(value) !== JSON.stringify(r.resolvedValue)) {
        throw new Error("value differs from Phase 0 resolution");
      }
      verifiedOk++;
    } catch (e) {
      verifyFailures.push({
        row: r,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  printCheck(
    verifyFailures.length === 0,
    "Full readback via runtime path scheme",
    `${verifiedOk}/${prestaged.length}`,
  );
  if (verifyFailures.length > 0) {
    for (const { row, reason } of verifyFailures) {
      console.log(`     ${FAIL} ${row.id} (${row.vaultPath}): ${reason}`);
    }
    abort(
      "Readback verification failed. Investigate before proceeding to Phase 2.",
    );
  }

  // Summary
  console.log(`\n${SECTION}`);
  console.log(`  Phase 1 summary`);
  console.log(SECTION);
  console.log(`  ${OK} Backup table present`);
  console.log(
    `  ${OK} ${writes} written, ${idempotent} already present, ${prestaged.length} total`,
  );
  console.log(
    `  ${OK} ${verifiedOk}/${prestaged.length} paths verified via runtime read scheme`,
  );
  console.log(`  ${INFO} Pre-staged in Vault:`);
  for (const r of prestaged) {
    console.log(`     • ${r.id} → ${r.vaultPath}`);
  }
  console.log(SECTION);
  console.log(`
  At this point:
    • All values are present in the target Vault at the paths
      VaultSecretManager will use after the env-var flip.
    • Database is unchanged. Live service still serves reads
      through the READONLY_VAULT resolver normally.
    • To abandon the migration at this point: DROP TABLE ${BACKUP_TABLE}
      and (optionally) delete the target-Vault entries — they're inert
      in READONLY_VAULT mode and harmless if left in place.
`);

  console.log(`
  Next, Phase 2 — switch from READONLY_VAULT to Archestra-managed Vault.

  This needs a maintenance window. Between the SQL flip and the backend
  restart under the new env, the secret table won't read correctly: the
  rows have empty references that READONLY_VAULT mode can't resolve, and
  the env still says READONLY_VAULT (so VAULT-mode reads aren't enabled yet).

  Once you take the platform out of service, the script will:

    1. Run a single SQL transaction to upgrade the secrets format in the database.

    2. Pause and ask you to:
         • set ARCHESTRA_SECRETS_MANAGER=Vault
         • restart the backend

  If something goes wrong post-flip, re-run this script with --rollback to
  restore the secret table from ${BACKUP_TABLE}, or run the equivalent SQL
  by hand:

       BEGIN;
       UPDATE secret AS s
          SET secret = b.secret,
              is_vault = b.is_vault,
              is_byos_vault = b.is_byos_vault,
              name = b.name,
              updated_at = b.updated_at
         FROM ${BACKUP_TABLE} AS b
        WHERE s.id = b.id;
       COMMIT;
`);
  const cont = await confirm("Proceed with Phase 2?");
  if (!cont) {
    console.log(`\n${INFO} Aborted by operator. Phase 1 work is preserved.`);
    process.exit(0);
  }

  return prestaged;
}

// ============================================================
// Phase 2 — Atomic DB flip + env-var change
// ============================================================

async function phase2AtomicFlip(
  prestaged: PrestagedRow[],
  preflight: PreflightResult,
): Promise<{ commitTs: Date }> {
  printHeader("Phase 2 — Atomic DB flip + env-var change");

  console.log(`
  Take the backend out of service before continuing.
`);
  const ready = await confirm("Have you taken the platform out of service?");
  if (!ready) {
    console.log(`\n${INFO} Aborted. Phase 1 writes remain in Vault.`);
    process.exit(0);
  }

  // The transaction
  const allIds = prestaged.map((r) => r.id);
  const renames = prestaged.filter((r) => r.sanitizedName !== r.name);

  console.log(`\n  Running atomic transaction:`);
  console.log(
    `    • rename ${renames.length} row${renames.length === 1 ? "" : "s"} to sanitized names:`,
  );
  for (const r of renames) {
    console.log(`        ${r.id}: "${r.name}" → "${r.sanitizedName}"`);
  }
  console.log(
    `    • flip ${allIds.length} row${allIds.length === 1 ? "" : "s"} to is_vault=true / is_byos_vault=false / secret={}:`,
  );
  for (const id of allIds) {
    console.log(`        ${id}`);
  }

  await db.transaction(async (tx) => {
    for (const r of renames) {
      await tx
        .update(schema.secretsTable)
        .set({ name: r.sanitizedName })
        .where(eq(schema.secretsTable.id, r.id));
    }

    await tx
      .update(schema.secretsTable)
      .set({ secret: {}, isVault: true, isByosVault: false })
      .where(inArray(schema.secretsTable.id, allIds));

    // Same Drizzle array-spread caveat as fkImpactReport — wrap in ARRAY[].
    const idsArrayLit = sql`ARRAY[${sql.join(
      allIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    const sanity = await tx.execute(sql`
      SELECT count(*)::int AS c
      FROM secret
      WHERE id = ANY(${idsArrayLit})
        AND (is_vault != true OR is_byos_vault != false OR secret != '{}'::jsonb)
    `);
    const mismatchCount = (sanity.rows[0] as { c: number }).c;
    if (mismatchCount > 0) {
      throw new Error(
        `In-transaction sanity check failed: ${mismatchCount} rows did not flip cleanly. Rolling back.`,
      );
    }
  });
  const commitTs = new Date();

  printCheck(true, "Transaction committed");

  // Pre-restart verification: read EVERY pre-staged path from Vault using
  // the same path scheme VaultSecretManager will use, and confirm byte
  // equality with the values we wrote in Phase 1.
  let postFlipOk = 0;
  const postFlipFailures: { row: PrestagedRow; reason: string }[] = [];
  for (const r of prestaged) {
    try {
      const response = await preflight.vaultClient.readOrNull(r.vaultPath);
      if (!response) throw new Error("not found");
      const got = preflight.vaultClient.extractValueFrom(response);
      if (got !== JSON.stringify(r.resolvedValue)) {
        throw new Error("bytes differ from Phase 1 write");
      }
      postFlipOk++;
    } catch (e) {
      postFlipFailures.push({
        row: r,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  printCheck(
    postFlipFailures.length === 0,
    "Post-flip Vault re-read",
    `${postFlipOk}/${prestaged.length}`,
  );
  if (postFlipFailures.length > 0) {
    for (const { row, reason } of postFlipFailures) {
      console.log(`     ${FAIL} ${row.id} (${row.vaultPath}): ${reason}`);
    }
    abort(
      `Post-flip Vault verification failed. The DB transaction has already committed (rows are now is_vault=true with empty payloads), so bringing the backend up under VAULT mode WILL break reads for these secrets.\n\nTwo recovery options:\n  1. Investigate the Vault disturbance, restore the missing/incorrect entries (re-running this script is safe — Phase 1's writes are idempotent and will repair them). Then restart the backend under VAULT mode.\n  2. Restore the secret table by hand from ${BACKUP_TABLE}:\n       BEGIN;\n       UPDATE secret AS s\n          SET secret = b.secret, is_vault = b.is_vault,\n              is_byos_vault = b.is_byos_vault, name = b.name,\n              updated_at = b.updated_at\n         FROM ${BACKUP_TABLE} AS b\n        WHERE s.id = b.id;\n       COMMIT;\n     Then revert ARCHESTRA_SECRETS_MANAGER to READONLY_VAULT and restart.\n\nDo NOT proceed with the env-var flip until one of these is done.`,
    );
  }

  console.log(`
  The DB transaction completed. Now do the following:

  1. In your backend deployment, change ARCHESTRA_SECRETS_MANAGER from
     READONLY_VAULT to Vault. Leave the other ARCHESTRA_HASHICORP_VAULT_*
     vars as they are.
  2. Start the backend back up.
  3. Verify health: GET /api/secrets/type — expect type "Vault".
`);
  await pressEnter("Press Enter once the backend is up under the new config: ");

  // Final live-side verification
  const counts = await getRowCounts();
  printCheck(
    counts.byos === 0,
    "Database has no remaining READONLY_VAULT rows",
    `${counts.byos} READONLY_VAULT / ${counts.vault} Vault / ${counts.db} DB`,
  );

  console.log(`\n${SECTION}`);
  console.log(`  Phase 2 summary`);
  console.log(SECTION);
  console.log(`  ${OK} Renamed ${renames.length} rows`);
  console.log(`  ${OK} Flipped ${allIds.length} rows to Vault mode`);
  console.log(
    `  ${OK} ${postFlipOk}/${prestaged.length} paths verified post-flip`,
  );
  console.log(SECTION);

  return { commitTs };
}

// ============================================================
// Phase 4 — Post-migration consistency audit (required tier)
//
// Runs immediately after Phase 2's final verification, before Phase 3's
// soak guidance. Fails loudly on any anomaly. Operator must fix the
// finding (or roll back) before treating the migration as complete.
// ============================================================

interface AuditFinding {
  check: string;
  detail: string;
}

async function phase4Audit(
  prestaged: PrestagedRow[],
  preflight: PreflightResult,
  commitTs: Date,
): Promise<void> {
  printHeader("Phase 4 — Post-migration consistency audit");

  const findings: AuditFinding[] = [];
  const warnings: AuditFinding[] = [];
  const fail = (check: string, detail: string) =>
    findings.push({ check, detail });
  const warn = (check: string, detail: string) => {
    printWarn(check, detail);
    warnings.push({ check, detail });
  };

  const migratedIdSet = new Set(prestaged.map((r) => r.id));
  const migratedArr = Array.from(migratedIdSet);
  const idsArrayLit =
    migratedArr.length > 0
      ? sql`ARRAY[${sql.join(
          migratedArr.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`
      : sql`ARRAY[]::uuid[]`;

  // ---- DB state ----

  // C1: row-count parity. Phase 2 only UPDATEs — total count must equal
  // Phase 0 baseline.
  const liveCountResult = await db.execute(
    sql`SELECT count(*)::int AS c FROM secret`,
  );
  const liveCount = (liveCountResult.rows[0] as { c: number }).c;
  if (liveCount !== preflight.snapshot.totalSecretCount) {
    fail(
      "C1 row-count parity",
      `live=${liveCount} but Phase 0 baseline=${preflight.snapshot.totalSecretCount}`,
    );
  } else {
    printCheck(true, "C1 row-count parity", `live=${liveCount} = baseline`);
  }

  // C2: id-set unchanged.
  const liveIdsResult = await db.execute(
    sql`SELECT id::text AS id FROM secret`,
  );
  const liveIds = new Set(
    (liveIdsResult.rows as { id: string }[]).map((r) => r.id),
  );
  const addedIds = Array.from(liveIds).filter(
    (id) => !preflight.snapshot.allSecretIds.has(id),
  );
  const removedIds = Array.from(preflight.snapshot.allSecretIds).filter(
    (id) => !liveIds.has(id),
  );
  if (addedIds.length > 0 || removedIds.length > 0) {
    fail(
      "C2 id-set unchanged",
      `added=${addedIds.length} (${addedIds.slice(0, 3).join(", ") || "—"}), removed=${removedIds.length} (${removedIds.slice(0, 3).join(", ") || "—"})`,
    );
  } else {
    printCheck(true, "C2 id-set unchanged", `${liveIds.size} rows`);
  }

  // C3: every migrated id has is_vault=true / is_byos_vault=false AND a
  // semantically-empty `secret` column.
  //
  // Phase 2 writes literal `'{}'::jsonb`. But the *natural* runtime state of
  // any is_vault=true row in this codebase is the encrypted form
  // `{"__encrypted":"v1:…"}` (i.e. `encryptSecretValue({})`), produced by
  // `SecretModel.create({secret: {}, isVault: true})` in `models/secret.ts`
  // and by `VaultSecretManager.{create,update}Secret` in `vault.ee.ts`. So
  // between Phase 2 commit and Phase 4 audit — during which the operator
  // restarts the backend per the script's instructions — any runtime
  // touch on a migrated row will rewrite `secret` from literal `{}` to
  // `encrypt({})`. Both are valid empty placeholders; both decrypt to `{}`.
  // C3 accepts either: it fetches the rows and verifies that, after
  // optional decryption, the secret object has zero keys.
  const c3Rows = await db.execute(sql`
    SELECT id::text AS id, is_vault, is_byos_vault, secret
    FROM secret
    WHERE id = ANY(${idsArrayLit})
  `);
  const c3Failures: string[] = [];
  for (const row of c3Rows.rows as {
    id: string;
    is_vault: boolean;
    is_byos_vault: boolean;
    secret: unknown;
  }[]) {
    if (row.is_vault !== true) {
      c3Failures.push(`${row.id} has is_vault=${row.is_vault} (want true)`);
      continue;
    }
    if (row.is_byos_vault !== false) {
      c3Failures.push(
        `${row.id} has is_byos_vault=${row.is_byos_vault} (want false)`,
      );
      continue;
    }
    let plaintext: unknown = row.secret;
    if (isEncryptedSecret(plaintext)) {
      try {
        plaintext = decryptSecretValue(plaintext as { __encrypted: string });
      } catch (e) {
        c3Failures.push(
          `${row.id} secret column has __encrypted blob that fails to decrypt: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
    }
    if (
      plaintext === null ||
      typeof plaintext !== "object" ||
      Object.keys(plaintext as Record<string, unknown>).length !== 0
    ) {
      const keys =
        plaintext && typeof plaintext === "object"
          ? Object.keys(plaintext as Record<string, unknown>)
          : [];
      c3Failures.push(
        `${row.id} secret column is not empty (decrypted keys: ${keys.length > 0 ? keys.join(", ") : "<not-an-object>"})`,
      );
    }
  }
  if (c3Failures.length > 0) {
    fail(
      "C3 migrated rows fully flipped",
      `${c3Failures.length} migrated row(s) failed: ${c3Failures.slice(0, 3).join("; ")}`,
    );
  } else {
    printCheck(
      true,
      "C3 migrated rows fully flipped",
      `${migratedArr.length}/${migratedArr.length}`,
    );
  }

  // C4: non-migrated rows have byte-equal `secret` JSONB to backup.
  const a3Result = await db.execute(sql`
    SELECT count(*)::int AS c
    FROM secret s
    JOIN ${sql.identifier(BACKUP_TABLE)} b USING (id)
    WHERE s.id != ALL(${idsArrayLit})
      AND s.secret IS DISTINCT FROM b.secret
  `);
  const a3DiffCount = (a3Result.rows[0] as { c: number }).c;
  if (a3DiffCount > 0) {
    fail(
      "C4 non-migrated rows preserved",
      `${a3DiffCount} non-migrated row(s) have a different secret column than the backup`,
    );
  } else {
    printCheck(
      true,
      "C4 non-migrated rows preserved",
      "all secret columns byte-equal to backup",
    );
  }

  // C5: every migrated row's updated_at is in [Phase 0 baseline, commit + 1s].
  // Tolerance: clock skew between Node and Postgres can be a few seconds.
  const skewMs = 5000;
  const upperBound = new Date(commitTs.getTime() + skewMs);
  const lowerBound = preflight.snapshot.maxSecretUpdatedAt
    ? new Date(preflight.snapshot.maxSecretUpdatedAt.getTime())
    : new Date(0);
  const a6 = await db.execute(sql`
    SELECT count(*)::int AS c
    FROM secret
    WHERE id = ANY(${idsArrayLit})
      AND (updated_at < ${lowerBound} OR updated_at > ${upperBound})
  `);
  const a6BadCount = (a6.rows[0] as { c: number }).c;
  if (a6BadCount > 0) {
    fail(
      "C5 updated_at within commit window",
      `${a6BadCount} migrated row(s) have updated_at outside [Phase0 max, commit+${skewMs}ms]`,
    );
  } else {
    printCheck(
      true,
      "C5 updated_at within commit window",
      `commit=${commitTs.toISOString()}`,
    );
  }

  // C6: every migrated row's `name` matches its sanitized name.
  const expectedNames = new Map(prestaged.map((r) => [r.id, r.sanitizedName]));
  const a7Result = await db.execute(sql`
    SELECT id::text AS id, name FROM secret WHERE id = ANY(${idsArrayLit})
  `);
  const a7Mismatches: { id: string; live: string; expected: string }[] = [];
  for (const row of a7Result.rows as { id: string; name: string }[]) {
    const expected = expectedNames.get(row.id);
    if (expected && row.name !== expected) {
      a7Mismatches.push({ id: row.id, live: row.name, expected });
    }
  }
  if (a7Mismatches.length > 0) {
    fail(
      "C6 name = sanitized name",
      `${a7Mismatches.length} row(s) with name not matching sanitized form: ${a7Mismatches
        .slice(0, 3)
        .map((m) => `${m.id} (live="${m.live}", expected="${m.expected}")`)
        .join("; ")}`,
    );
  } else {
    printCheck(
      true,
      "C6 name = sanitized name",
      `${expectedNames.size}/${expectedNames.size}`,
    );
  }

  // C7: only migrated rows changed; stale-skipped rows have unchanged
  // updated_at from Phase 0. Approximation: stale ids' updated_at <= baseline.
  if (
    preflight.snapshot.staleIds.size > 0 &&
    preflight.snapshot.maxSecretUpdatedAt
  ) {
    const staleArr = Array.from(preflight.snapshot.staleIds);
    const staleArrayLit = sql`ARRAY[${sql.join(
      staleArr.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    const f1 = await db.execute(sql`
      SELECT count(*)::int AS c
      FROM secret
      WHERE id = ANY(${staleArrayLit})
        AND updated_at > ${preflight.snapshot.maxSecretUpdatedAt}
    `);
    const f1BadCount = (f1.rows[0] as { c: number }).c;
    if (f1BadCount > 0) {
      fail(
        "C7 stale rows untouched",
        `${f1BadCount} stale-skipped row(s) have updated_at newer than Phase 0 baseline`,
      );
    } else {
      printCheck(
        true,
        "C7 stale rows untouched",
        `${staleArr.length} stale row(s) preserved`,
      );
    }
  }

  // ---- Vault state ----

  // C8: every migrated id has a Vault entry with all expected archestra keys.
  let b1Ok = 0;
  const b1Failures: { row: PrestagedRow; reason: string }[] = [];
  for (const r of prestaged) {
    try {
      const response = await preflight.vaultClient.readOrNull(r.vaultPath);
      if (!response) {
        b1Failures.push({ row: r, reason: "Vault entry missing" });
        continue;
      }
      const value = JSON.parse(
        preflight.vaultClient.extractValueFrom(response),
      ) as Record<string, unknown>;
      const expectedKeys = Object.keys(r.references);
      const actualKeys = Object.keys(value);
      const missingKeys = expectedKeys.filter((k) => !(k in value));
      if (missingKeys.length > 0) {
        b1Failures.push({
          row: r,
          reason: `value present but missing keys: ${missingKeys.join(", ")}`,
        });
        continue;
      }
      const extraKeys = actualKeys.filter((k) => !expectedKeys.includes(k));
      if (extraKeys.length > 0) {
        b1Failures.push({
          row: r,
          reason: `value has unexpected extra keys: ${extraKeys.join(", ")}`,
        });
        continue;
      }
      b1Ok++;
    } catch (e) {
      b1Failures.push({
        row: r,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (b1Failures.length > 0) {
    fail(
      "C8 Vault entries present and key-complete",
      `${b1Failures.length}/${prestaged.length} Vault entries failed: ${b1Failures
        .slice(0, 3)
        .map((f) => `${f.row.id} — ${f.reason}`)
        .join("; ")}`,
    );
  } else {
    printCheck(
      true,
      "C8 Vault entries present and key-complete",
      `${b1Ok}/${prestaged.length}`,
    );
  }

  // C9 / C10 / C11: list under secretPath, identify orphans + probe-key residue.
  let listed: { name: string; path: string }[];
  try {
    listed = await preflight.vaultClient.listSecretsInFolder(
      preflight.vaultConfig.secretPath,
    );
  } catch (e) {
    fail(
      "C9 Vault entry listing",
      `cannot list ${preflight.vaultConfig.secretPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
    listed = [];
  }
  const probeResidue = listed.filter((entry) =>
    entry.name.startsWith(PROBE_KEY_BASE),
  );
  if (probeResidue.length > 0) {
    fail(
      "C10 no probe-key residue",
      `${probeResidue.length} probe key(s) lingering: ${probeResidue.map((e) => e.name).join(", ")}`,
    );
  } else if (listed.length > 0) {
    printCheck(true, "C10 no probe-key residue");
  }

  // Identify orphan-looking entries: parse <name>-<uuid>, check uuid against
  // the live DB. If the uuid doesn't exist in `secret` at all, that's an orphan.
  const uuidRe =
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const orphans: { entryName: string; uuid: string }[] = [];
  for (const entry of listed) {
    if (entry.name.startsWith(PROBE_KEY_BASE)) continue;
    const m = entry.name.match(uuidRe);
    if (!m) continue;
    const uuid = m[1].toLowerCase();
    if (!liveIds.has(uuid)) {
      orphans.push({ entryName: entry.name, uuid });
    }
  }
  if (orphans.length > 0) {
    fail(
      "C11 no orphan Vault entries",
      `${orphans.length} entries under ${preflight.vaultConfig.secretPath}/ reference an id not in the secret table: ${orphans
        .slice(0, 3)
        .map((o) => o.entryName)
        .join(", ")}`,
    );
  } else if (listed.length > 0) {
    printCheck(
      true,
      "C11 no orphan Vault entries",
      `${listed.length} entries listed, all matched to DB`,
    );
  }

  // ---- FK consumer integrity ----

  // C12 / C13: per FK column, non-null-total and refs-to-migrated-set match
  // baseline.

  for (const { table, column } of FK_TABLES) {
    const key = `${table}.${column}`;
    const baseline = preflight.snapshot.fkBaseline.get(key);
    if (!baseline) continue;
    const r = await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE ${sql.identifier(column)} IS NOT NULL)::int AS non_null_total,
        count(*) FILTER (WHERE ${sql.identifier(column)} = ANY(${idsArrayLit}))::int AS to_migrated
      FROM ${sql.identifier(table)}
    `);
    const { non_null_total, to_migrated } = r.rows[0] as {
      non_null_total: number;
      to_migrated: number;
    };
    if (non_null_total !== baseline.nonNullTotal) {
      fail(
        `C12 ${key} non-null count`,
        `live=${non_null_total} but baseline=${baseline.nonNullTotal}`,
      );
    } else if (to_migrated !== baseline.refsToMigratedSet) {
      fail(
        `C13 ${key} refs to migrated set`,
        `live=${to_migrated} but baseline=${baseline.refsToMigratedSet}`,
      );
    } else {
      printCheck(
        true,
        `C12+C13 ${key}`,
        `non_null=${non_null_total}, to_migrated=${to_migrated}`,
      );
    }
  }

  // C14: no FK consumer references a non-existent secret_id.
  for (const { table, column } of FK_TABLES) {
    const key = `${table}.${column}`;
    const r = await db.execute(sql`
      SELECT count(*)::int AS c
      FROM ${sql.identifier(table)} t
      WHERE t.${sql.identifier(column)} IS NOT NULL
        AND t.${sql.identifier(column)} NOT IN (SELECT id FROM secret)
    `);
    const dangling = (r.rows[0] as { c: number }).c;
    if (dangling > 0) {
      fail(`C14 ${key} no dangling FK`, `${dangling} dangling reference(s)`);
    }
  }

  // ---- Encryption / backup integrity ----

  // C15: sample-decrypt N backup rows.
  const sampleSize = 5;
  const d1Result = await db.execute(
    sql.raw(`
      SELECT id::text AS id, secret FROM "${BACKUP_TABLE}"
      ORDER BY random() LIMIT ${sampleSize}
    `),
  );
  let d1Ok = 0;
  const d1Failures: { id: string; reason: string }[] = [];
  for (const row of d1Result.rows as { id: string; secret: unknown }[]) {
    try {
      if (isEncryptedSecret(row.secret)) {
        decryptSecretValue(row.secret as { __encrypted: string });
      }
      d1Ok++;
    } catch (e) {
      d1Failures.push({
        id: row.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (d1Failures.length > 0) {
    fail(
      "C15 backup decryption probe",
      `${d1Failures.length}/${d1Result.rows.length} backup row(s) failed to decrypt: ${d1Failures
        .slice(0, 3)
        .map((f) => `${f.id} — ${f.reason}`)
        .join("; ")} — has ARCHESTRA_AUTH_SECRET been rotated?`,
    );
  } else if (d1Result.rows.length > 0) {
    printCheck(
      true,
      "C15 backup decryption probe",
      `${d1Ok}/${d1Result.rows.length} sampled backup rows decrypt cleanly`,
    );
  }

  // C16: sample-decrypt N non-migrated live rows.
  const d2Result = await db.execute(sql`
    SELECT id::text AS id, secret FROM secret
    WHERE id != ALL(${idsArrayLit})
    ORDER BY random() LIMIT ${sampleSize}
  `);
  let d2Ok = 0;
  const d2Failures: { id: string; reason: string }[] = [];
  for (const row of d2Result.rows as { id: string; secret: unknown }[]) {
    try {
      if (isEncryptedSecret(row.secret)) {
        decryptSecretValue(row.secret as { __encrypted: string });
      }
      d2Ok++;
    } catch (e) {
      d2Failures.push({
        id: row.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (d2Failures.length > 0) {
    fail(
      "C16 live non-migrated decryption probe",
      `${d2Failures.length}/${d2Result.rows.length} live row(s) failed to decrypt: ${d2Failures
        .slice(0, 3)
        .map((f) => `${f.id} — ${f.reason}`)
        .join("; ")}`,
    );
  } else if (d2Result.rows.length > 0) {
    printCheck(
      true,
      "C16 live non-migrated decryption probe",
      `${d2Ok}/${d2Result.rows.length} sampled live rows decrypt cleanly`,
    );
  }

  // C17 (warn): backup column names + types match live `secret`. If a schema
  // migration ran between Phase 1 (CREATE TABLE AS) and now, the backup may
  // not faithfully replay into the live table during a manual restore. We
  // warn — operator decides if the delta is benign (added nullable column)
  // or destructive (dropped column).
  //
  // We DO NOT compare `is_nullable`: Postgres `CREATE TABLE … AS SELECT *`
  // copies column types but NOT NOT-NULL constraints, so the backup table is
  // structurally born with all-nullable columns even when the source has
  // NOT NULL. Comparing nullability would false-positive on every column.
  // Schema drift that matters for manual restore (added/removed/retyped
  // column) is still caught by name + type comparison.
  const liveCols = await db.execute(sql`
    SELECT column_name AS name, data_type AS type
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'secret'
    ORDER BY ordinal_position
  `);
  const backupCols = await db.execute(sql`
    SELECT column_name AS name, data_type AS type
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${BACKUP_TABLE}
      AND column_name <> 'backed_up_at'
    ORDER BY ordinal_position
  `);
  type ColRow = { name: string; type: string };
  const liveColMap = new Map(
    (liveCols.rows as ColRow[]).map((c) => [c.name, c]),
  );
  const backupColMap = new Map(
    (backupCols.rows as ColRow[]).map((c) => [c.name, c]),
  );
  const liveOnly = [...liveColMap.keys()].filter((n) => !backupColMap.has(n));
  const backupOnly = [...backupColMap.keys()].filter((n) => !liveColMap.has(n));
  const typeMismatches: string[] = [];
  for (const [name, live] of liveColMap) {
    const bak = backupColMap.get(name);
    if (!bak) continue;
    if (live.type !== bak.type) {
      typeMismatches.push(`${name} (live=${live.type}, backup=${bak.type})`);
    }
  }
  if (
    liveOnly.length > 0 ||
    backupOnly.length > 0 ||
    typeMismatches.length > 0
  ) {
    const parts: string[] = [];
    if (liveOnly.length > 0)
      parts.push(`live-only columns: ${liveOnly.join(", ")}`);
    if (backupOnly.length > 0)
      parts.push(`backup-only columns: ${backupOnly.join(", ")}`);
    if (typeMismatches.length > 0)
      parts.push(`type mismatches: ${typeMismatches.join("; ")}`);
    warn(
      "C17 backup column-list matches live secret",
      `${parts.join(" | ")} — a schema migration likely ran between Phase 1 and now. Inspect each delta before relying on a manual restore from ${BACKUP_TABLE}.`,
    );
  } else {
    printCheck(
      true,
      "C17 backup column-list matches live secret",
      `${liveColMap.size} columns identical`,
    );
  }

  // ---- Runtime connectivity ----

  // C18 (warn): runtime POST /api/secrets/check-connectivity succeeds. This
  // confirms the backend (running under the new ARCHESTRA_SECRETS_MANAGER=Vault
  // config) can list secrets in the target Vault. Skipped if MIGRATION_BACKEND_URL
  // is not set; warn (not fail) on failure because the backend may simply not
  // be running yet, or the operator may not have wired up an API key.
  const auditBackendUrl = process.env.MIGRATION_BACKEND_URL;
  if (auditBackendUrl) {
    const apiKey = process.env.MIGRATION_BACKEND_API_KEY;
    try {
      const resp = await fetch(
        `${auditBackendUrl}/api/secrets/check-connectivity`,
        {
          method: "POST",
          headers: apiKey ? { Authorization: apiKey } : undefined,
        },
      );
      if (!resp.ok) {
        warn(
          "C18 runtime check-connectivity",
          `HTTP ${resp.status} from ${auditBackendUrl}/api/secrets/check-connectivity${resp.status === 401 ? " (set MIGRATION_BACKEND_API_KEY to authenticate)" : ""}`,
        );
      } else {
        const body = (await resp.json()) as { secretCount?: number };
        if (typeof body.secretCount !== "number") {
          warn(
            "C18 runtime check-connectivity",
            `200 OK but response missing secretCount field: ${JSON.stringify(body)}`,
          );
        } else {
          printCheck(
            true,
            "C18 runtime check-connectivity",
            `secretCount=${body.secretCount}`,
          );
        }
      }
    } catch (e) {
      warn(
        "C18 runtime check-connectivity",
        `request to ${auditBackendUrl} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // C18 silently skipped when MIGRATION_BACKEND_URL is unset — env var
  // is documented in the file header and the migration plan doc.

  // ---- Forensic audit-trail manifest ----
  //
  // Write a plain-text record of what happened to a file in CWD so the
  // operator has an artifact for compliance / post-mortem review without
  // needing to re-derive it from logs. NEVER include secret VALUES, only:
  //   - row IDs, original + sanitized names, destination Vault paths
  //   - the source READONLY_VAULT path#key references (addresses, not values)
  //   - the destination key names (e.g. "API_KEY") within each entry
  //   - counts, timestamps, FK baselines, audit findings
  // The path#key references are addresses to BYOS Vault locations — they
  // describe WHERE values lived, never WHAT they were. Including them gives
  // the audit trail a complete old→new mapping for traceability.
  const manifestPath = await writeAuditManifest({
    preflight,
    prestaged,
    commitTs,
    findings,
    warnings,
  });
  console.log(`\n  ${INFO} Audit-trail manifest written to ${manifestPath}`);
  console.log(`     (No secret values are recorded in the file.)`);

  // ---- Audit summary ----

  console.log(`\n${SECTION}`);
  console.log(`  Phase 4 audit summary`);
  console.log(SECTION);
  if (findings.length === 0 && warnings.length === 0) {
    console.log(`  ${OK} All consistency checks passed.`);
    console.log(SECTION);
    return;
  }
  if (findings.length > 0) {
    console.log(
      `  ${FAIL} ${findings.length} required check${findings.length === 1 ? "" : "s"} failed:`,
    );
    for (const f of findings) {
      console.log(`     • ${f.check}: ${f.detail}`);
    }
  }
  if (warnings.length > 0) {
    console.log(
      `  ${WARN} ${warnings.length} recommended check${warnings.length === 1 ? "" : "s"} produced warnings (non-fatal):`,
    );
    for (const w of warnings) {
      console.log(`     • ${w.check}: ${w.detail}`);
    }
  }
  console.log(SECTION);
  if (findings.length > 0) {
    abort(
      `Post-migration audit found ${findings.length} anomaly/anomalies. Investigate each one before treating the migration as complete. If the anomalies indicate broken state that can't be repaired in place, restore manually from ${BACKUP_TABLE} (see the SQL block in the post-flip verification error message above). DO NOT skip these.`,
    );
  }
  console.log(
    `  ${INFO} Required checks passed; recommended checks above are advisory — review them, but they do not block proceeding.`,
  );
}

// ============================================================
// Forensic audit-trail manifest
// ============================================================

async function writeAuditManifest(args: {
  preflight: PreflightResult;
  prestaged: PrestagedRow[];
  commitTs: Date;
  findings: AuditFinding[];
  warnings: AuditFinding[];
}): Promise<string> {
  const { preflight, prestaged, commitTs, findings, warnings } = args;
  const generatedAt = new Date();
  const filenameTs = generatedAt.toISOString().replace(/[:.]/g, "-");
  const filename = `vault-migration-audit-${filenameTs}.txt`;
  const filepath = path.resolve(process.cwd(), filename);

  const HR = "=".repeat(70);
  const SUB = "-".repeat(70);
  const lines: string[] = [];

  lines.push("Vault Migration Audit Trail");
  lines.push(`Generated:         ${generatedAt.toISOString()}`);
  lines.push(`Script:            migrate-byos-to-vault`);
  lines.push(`Working directory: ${process.cwd()}`);
  lines.push(`Node version:      ${process.version}`);
  lines.push("");
  lines.push(
    "NOTE: This file is safe to share for audit purposes. It contains NO",
  );
  lines.push(
    "secret values. It does include addresses to secret-store locations:",
  );
  lines.push(
    "  - Source READONLY_VAULT references (path#key — addresses in your",
  );
  lines.push("    BYOS Vault, NOT the values stored at those addresses)");
  lines.push("  - Destination Vault paths in the new write-enabled Vault");
  lines.push('  - Key names (e.g. "API_KEY") that exist within each entry');
  lines.push("");

  lines.push(HR);
  lines.push("MIGRATION TARGET (write-enabled Vault)");
  lines.push(HR);
  lines.push(`Vault address:        ${preflight.vaultConfig.address}`);
  lines.push(`Auth method:          ${preflight.vaultConfig.authMethod}`);
  lines.push(`KV version:           ${preflight.vaultConfig.kvVersion}`);
  lines.push(`Secret path:          ${preflight.vaultConfig.secretPath}`);
  if (preflight.vaultConfig.secretMetadataPath) {
    lines.push(
      `Metadata path:        ${preflight.vaultConfig.secretMetadataPath}`,
    );
  }
  lines.push(`(Auth credentials are NOT recorded.)`);
  lines.push("");

  lines.push(HR);
  lines.push("PHASE 0 — BASELINE SNAPSHOT");
  lines.push(HR);
  lines.push(
    `Total rows in secret:           ${preflight.snapshot.totalSecretCount}`,
  );
  lines.push(
    `Max updated_at:                 ${preflight.snapshot.maxSecretUpdatedAt?.toISOString() ?? "<none>"}`,
  );
  lines.push(`Migratable READONLY_VAULT rows: ${prestaged.length}`);
  lines.push(
    `Stale-skipped rows:             ${preflight.snapshot.staleIds.size}`,
  );
  lines.push(
    `Backup table reused:            ${preflight.reuseExistingBackup}`,
  );
  lines.push("");
  lines.push(`FK consumer baseline (per FK column):`);
  for (const [key, base] of preflight.snapshot.fkBaseline) {
    lines.push(
      `  ${key.padEnd(50)} non_null=${base.nonNullTotal}, refs_to_migrated=${base.refsToMigratedSet}`,
    );
  }
  lines.push("");

  lines.push(HR);
  lines.push("BACKUP TABLE");
  lines.push(HR);
  lines.push(`Table name: ${BACKUP_TABLE}`);
  lines.push(
    `Schema:     copy of public.secret as of Phase 1 + backed_up_at column`,
  );
  lines.push("");

  lines.push(HR);
  lines.push(`PHASE 1 — MIGRATED ROWS (${prestaged.length} rows)`);
  lines.push(HR);
  lines.push(
    `For each row: ID, names, destination Vault path, and the key-by-key`,
  );
  lines.push(
    `mapping showing where each archestra key was sourced from in the`,
  );
  lines.push(`READONLY_VAULT (path#key) and where it now lives in the new`);
  lines.push(`Vault.`);
  lines.push("");
  for (const r of prestaged) {
    const keyEntries = Object.entries(r.references);
    lines.push(`Row ${r.id}`);
    lines.push(`  Sanitized name:  ${r.sanitizedName}`);
    lines.push(`  Original name:   ${r.name}`);
    lines.push(`  Vault path:      ${r.vaultPath}`);
    if (keyEntries.length === 0) {
      lines.push(`  Keys (0):        <none>`);
    } else {
      lines.push(`  Keys (${keyEntries.length}):`);
      for (const [archestraKey, byosRef] of keyEntries) {
        lines.push(`    ${archestraKey}`);
        lines.push(`      old (READONLY_VAULT):  ${byosRef}`);
        lines.push(
          `      new (Vault):           ${r.vaultPath}#${archestraKey}`,
        );
      }
    }
    lines.push("");
  }

  if (preflight.snapshot.staleIds.size > 0) {
    lines.push(SUB);
    lines.push(`Stale-skipped rows (NOT migrated, left untouched in DB):`);
    lines.push(SUB);
    for (const id of preflight.snapshot.staleIds) {
      const row = preflight.rows.find((r) => r.id === id);
      lines.push(`  ${id}  name="${row?.name ?? "<unknown>"}"`);
    }
    lines.push("");
  }

  lines.push(HR);
  lines.push("PHASE 2 — ATOMIC FLIP");
  lines.push(HR);
  lines.push(`Commit timestamp: ${commitTs.toISOString()}`);
  lines.push(`Rows renamed:     ${prestaged.length}`);
  lines.push(`Rows flipped:     ${prestaged.length}`);
  lines.push(
    `Flip set:         is_byos_vault=true → is_vault=true, is_byos_vault=false, secret='{}'::jsonb`,
  );
  lines.push("");

  lines.push(HR);
  lines.push("PHASE 4 — POST-MIGRATION CONSISTENCY AUDIT");
  lines.push(HR);
  if (findings.length === 0) {
    lines.push("Required checks (C1–C16): ALL PASSED");
  } else {
    lines.push(`Required checks (C1–C16): ${findings.length} FAILURE(S)`);
    for (const f of findings) {
      lines.push(`  [FAIL] ${f.check}`);
      lines.push(`         ${f.detail}`);
    }
  }
  lines.push("");
  if (warnings.length === 0) {
    lines.push("Recommended checks (C17–C18): ALL PASSED");
  } else {
    lines.push(`Recommended checks (C17–C18): ${warnings.length} WARNING(S)`);
    for (const w of warnings) {
      lines.push(`  [WARN] ${w.check}`);
      lines.push(`         ${w.detail}`);
    }
  }
  lines.push("");

  lines.push(HR);
  lines.push("OUTCOME");
  lines.push(HR);
  if (findings.length === 0 && warnings.length === 0) {
    lines.push("All required and recommended checks passed.");
  } else if (findings.length === 0) {
    lines.push(
      `All required checks passed. ${warnings.length} recommended warning(s) — review above.`,
    );
  } else {
    lines.push(
      `${findings.length} required check(s) FAILED — investigate before treating migration as complete.`,
    );
  }
  lines.push("");
  lines.push(HR);
  lines.push("END OF AUDIT TRAIL");
  lines.push(HR);

  await writeFile(filepath, `${lines.join("\n")}\n`, "utf8");
  return filepath;
}

// ============================================================
// Phase 3 — Soak guidance
// ============================================================

function phase3SoakGuidance(): void {
  printHeader("Phase 3 — Soak");
  console.log(`
  Migration appears successful.

  Suggested soak: at least 24 hours of normal traffic before cleanup.

  Risks during the soak window:
    • Secrets created or updated through the UI in this window live
      in the target Vault and are NOT in the backup table.
      A manual restore from ${BACKUP_TABLE} during the soak would lose
      those new secrets.

  When ready to commit (no manual recovery possible after this):

    DROP TABLE ${BACKUP_TABLE};
`);
}

// ============================================================
// Rollback
// ============================================================

async function rollback(): Promise<void> {
  printHeader("Rollback — restore secret table from backup");

  const backup = await checkBackupTable();
  if (!backup.exists) {
    abort(`Backup table "${BACKUP_TABLE}" not found. Nothing to restore from.`);
  }

  const counts = await getRowCounts();
  const currentMode = getSecretsManagerTypeBasedOnEnvVars();

  console.log(`
  Current state:
    • Mode: ${modeLabel(currentMode)}
    • secret table: ${counts.byos} READONLY_VAULT, ${counts.vault} Vault, ${counts.db} plain DB
    • ${BACKUP_TABLE}: ${backup.rowCount} row${backup.rowCount === 1 ? "" : "s"}

  This will revert the secret table to the backup version in a single
  transaction. Rows created after the backup are NOT touched, and the
  ${BACKUP_TABLE} table itself is left in place.

  Before continuing, take the backend out of service and revert
  ARCHESTRA_SECRETS_MANAGER to READONLY_VAULT (if you already flipped it).
`);

  const proceed = await confirm("Restore the secret table from the backup?");
  if (!proceed) {
    console.log(`\n${INFO} Aborted. No changes made.`);
    return;
  }

  let restoredCount = 0;
  await db.transaction(async (tx) => {
    const result = await tx.execute(
      sql.raw(`
      UPDATE secret AS s
         SET secret = b.secret,
             is_vault = b.is_vault,
             is_byos_vault = b.is_byos_vault,
             name = b.name,
             updated_at = b.updated_at
        FROM "${BACKUP_TABLE}" AS b
       WHERE s.id = b.id
    `),
    );
    restoredCount = result.rowCount ?? 0;
  });

  printCheck(
    true,
    "Restore committed",
    `${restoredCount} row${restoredCount === 1 ? "" : "s"} updated`,
  );

  const after = await getRowCounts();
  console.log(
    `  ${INFO} secret table now: ${after.byos} READONLY_VAULT, ${after.vault} Vault, ${after.db} plain DB`,
  );
  console.log(`
  Next steps:
    • Restart the backend under ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT.
    • Verify health: GET /api/secrets/type — expect type "READONLY_VAULT".
    • Once you've confirmed the rollback is good, drop the backup table:
        DROP TABLE ${BACKUP_TABLE};
`);
}

// ============================================================
// Status
// ============================================================

async function status(): Promise<void> {
  printHeader("Migration status");

  const currentMode = getSecretsManagerTypeBasedOnEnvVars();
  printCheck(true, "Current mode", modeLabel(currentMode));
  printCheck(
    true,
    "Enterprise license",
    String(config.enterpriseFeatures.core),
  );

  const counts = await getRowCounts();
  console.log(
    `  ${INFO} Rows: ${counts.byos} READONLY_VAULT, ${counts.vault} Vault, ${counts.db} plain DB`,
  );

  const backup = await checkBackupTable();
  if (backup.exists) {
    console.log(
      `  ${INFO} Backup table "${BACKUP_TABLE}" exists (${backup.rowCount} rows)`,
    );
  } else {
    console.log(`  ${INFO} Backup table "${BACKUP_TABLE}" absent`);
  }

  let vaultConfigured = false;
  try {
    const vaultConfig = getVaultConfigFromEnv();
    vaultConfigured = true;
    console.log(
      `  ${INFO} Vault configured: ${vaultConfig.address} (${vaultConfig.authMethod}, KV v${vaultConfig.kvVersion})`,
    );
    const probe = new MigrationVaultClient(vaultConfig);
    try {
      await probe.listSecretsInFolder(vaultConfig.secretPath);
      printCheck(true, "Vault reachable (list)");
    } catch (e) {
      printCheck(false, "Vault reachable (list)", String(e));
    }
  } catch (e) {
    console.log(
      `  ${INFO} Vault config not readable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Suggested next step
  console.log(`\n  Suggested next step:`);
  if (
    currentMode === SecretsManagerType.BYOS_VAULT &&
    counts.byos > 0 &&
    !backup.exists
  ) {
    console.log(
      `    ${vaultConfigured ? `Run: ${INVOCATION}` : `Configure ARCHESTRA_HASHICORP_VAULT_*, then run: ${INVOCATION}`}`,
    );
  } else if (currentMode === SecretsManagerType.BYOS_VAULT && backup.exists) {
    console.log(`    Resume migration: ${INVOCATION}`);
    console.log(
      `    (Manual recovery from ${BACKUP_TABLE} is available — see the script header for the SQL.)`,
    );
  } else if (currentMode === SecretsManagerType.Vault && backup.exists) {
    console.log(
      `    Soak active. After observation period: DROP TABLE ${BACKUP_TABLE};`,
    );
    console.log(
      `    (Manual recovery from ${BACKUP_TABLE} is available until the table is dropped.)`,
    );
  } else if (currentMode === SecretsManagerType.Vault && !backup.exists) {
    console.log(`    Migration complete (or never run from this DB).`);
  } else {
    console.log(`    No action recommended.`);
  }
}

// ============================================================
// Main entry
// ============================================================

async function main(): Promise<void> {
  const mode = parseMode();

  await initializeDatabase();

  if (mode === "status") {
    await status();
    return;
  }

  if (mode === "rollback") {
    await rollback();
    return;
  }

  // Forward migration. Briefly wait so pino's async streams flush the
  // initializeDatabase boot logs before we print the welcome banner,
  // otherwise stdout interleaves the banner with the DB init lines.
  await new Promise((r) => setTimeout(r, 50));

  printWelcome();
  const ready = await confirm("Ready to start the migration?");
  if (!ready) {
    console.log(`\n${INFO} Aborted. No changes made.`);
    return;
  }
  const preflight = await phase0Preflight();
  const prestaged = await phase1Prestage(preflight);
  const { commitTs } = await phase2AtomicFlip(prestaged, preflight);
  await phase4Audit(prestaged, preflight, commitTs);
  phase3SoakGuidance();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\n${FAIL} Fatal error:`, error);
      process.exit(1);
    });
}
