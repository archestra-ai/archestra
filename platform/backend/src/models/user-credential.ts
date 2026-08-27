import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import type { UserCredential } from "@/types";

/** Field the credential value is stored under inside the secrets manager. */
const SECRET_VALUE_FIELD = "value";

/**
 * Personal credentials: values a single user has deposited for their own runs.
 *
 * The value only ever lives in the secrets manager. Nothing here (or on any
 * read path) returns it to a client — an owner may replace or delete their
 * credential, never read it back, and an administrator cannot read it at all.
 */
class UserCredentialModel {
  /**
   * Store or replace one credential. Replacement writes the new secret before
   * deleting the old one, so a crash mid-rotation leaves the credential intact
   * rather than stranding the user with a deployment they can no longer start.
   */
  static async upsert(params: {
    organizationId: string;
    userId: string;
    agentId: string;
    key: string;
    value: string;
  }): Promise<UserCredential> {
    const { organizationId, userId, agentId, key, value } = params;
    const existing = await UserCredentialModel.find({
      organizationId,
      userId,
      agentId,
      key,
    });
    const secret = await secretManager().createSecret(
      { [SECRET_VALUE_FIELD]: value },
      `agent-deployment-credential-${agentId}-${userId}-${key}`,
    );

    if (existing) {
      const [updated] = await db
        .update(schema.userCredentialsTable)
        .set({ secretId: secret.id, updatedAt: new Date() })
        .where(eq(schema.userCredentialsTable.id, existing.id))
        .returning();
      await deleteSecretQuietly(existing.secretId);
      return updated;
    }

    const [created] = await db
      .insert(schema.userCredentialsTable)
      .values({ organizationId, userId, agentId, key, secretId: secret.id })
      .returning();
    return created;
  }

  static async find(params: {
    organizationId: string;
    userId: string;
    agentId: string;
    key: string;
  }): Promise<UserCredential | null> {
    const [row] = await db
      .select()
      .from(schema.userCredentialsTable)
      .where(
        and(
          eq(schema.userCredentialsTable.organizationId, params.organizationId),
          eq(schema.userCredentialsTable.userId, params.userId),
          eq(schema.userCredentialsTable.agentId, params.agentId),
          eq(schema.userCredentialsTable.key, params.key),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async listForAgentUser(params: {
    organizationId: string;
    userId: string;
    agentId: string;
  }): Promise<UserCredential[]> {
    return db
      .select()
      .from(schema.userCredentialsTable)
      .where(
        and(
          eq(schema.userCredentialsTable.organizationId, params.organizationId),
          eq(schema.userCredentialsTable.userId, params.userId),
          eq(schema.userCredentialsTable.agentId, params.agentId),
        ),
      )
      .orderBy(asc(schema.userCredentialsTable.key));
  }

  /** Which of `keys` this user has on file — the cheap check behind preflight. */
  static async listPresentKeys(params: {
    organizationId: string;
    userId: string;
    agentId: string;
    keys: string[];
  }): Promise<Set<string>> {
    if (params.keys.length === 0) {
      return new Set();
    }
    const rows = await db
      .select({ key: schema.userCredentialsTable.key })
      .from(schema.userCredentialsTable)
      .where(
        and(
          eq(schema.userCredentialsTable.organizationId, params.organizationId),
          eq(schema.userCredentialsTable.userId, params.userId),
          eq(schema.userCredentialsTable.agentId, params.agentId),
          inArray(schema.userCredentialsTable.key, params.keys),
        ),
      );
    return new Set(rows.map((row) => row.key));
  }

  /**
   * Resolve values for injection into a run's Kubernetes Secret. A row whose
   * secret has vanished from the manager is reported as missing rather than
   * injected empty — an agent started with a blank token fails confusingly far
   * from the cause.
   */
  static async resolveValues(params: {
    organizationId: string;
    userId: string;
    agentId: string;
    keys: string[];
  }): Promise<{ values: Record<string, string>; missing: string[] }> {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    if (params.keys.length === 0) {
      return { values, missing };
    }
    const rows = await db
      .select()
      .from(schema.userCredentialsTable)
      .where(
        and(
          eq(schema.userCredentialsTable.organizationId, params.organizationId),
          eq(schema.userCredentialsTable.userId, params.userId),
          eq(schema.userCredentialsTable.agentId, params.agentId),
          inArray(schema.userCredentialsTable.key, params.keys),
        ),
      );
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const resolved = await Promise.all(
      params.keys.map(async (key) => {
        const row = byKey.get(key);
        if (!row) return { key, value: null };
        const secret = await secretManager().getSecret(row.secretId);
        const value = secret?.secret?.[SECRET_VALUE_FIELD];
        return {
          key,
          value: typeof value === "string" && value.length > 0 ? value : null,
        };
      }),
    );
    for (const entry of resolved) {
      if (entry.value === null) {
        missing.push(entry.key);
      } else {
        values[entry.key] = entry.value;
      }
    }
    return { values, missing };
  }

  static async delete(params: {
    organizationId: string;
    userId: string;
    agentId: string;
    key: string;
  }): Promise<boolean> {
    const existing = await UserCredentialModel.find(params);
    if (!existing) {
      return false;
    }
    await db
      .delete(schema.userCredentialsTable)
      .where(eq(schema.userCredentialsTable.id, existing.id));
    await deleteSecretQuietly(existing.secretId);
    return true;
  }
}

export default UserCredentialModel;

/**
 * A stale secret left behind is inert; a throw here would fail an otherwise
 * successful rotation or delete, so the failure is logged and swallowed.
 */
async function deleteSecretQuietly(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    logger.warn({ error, secretId }, "Failed to delete user credential secret");
  }
}
