import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";

interface A2APushNotificationConfigInput {
  taskId: string;
  url: string;
  token?: string | null;
  authScheme?: string | null;
  authCredentials?: string | null;
}

interface A2APushNotificationConfigRecord {
  id: string;
  taskId: string;
  url: string;
  token: string | null;
  authScheme: string | null;
  createdAt: Date;
}

class A2APushNotificationConfigModel {
  /**
   * Store a webhook config for a task. Credentials are encrypted at rest with
   * the platform secret key — they belong to the caller's endpoint, not to us.
   */
  static async create(
    input: A2APushNotificationConfigInput,
  ): Promise<A2APushNotificationConfigRecord> {
    const [row] = await db
      .insert(schema.a2aPushNotificationConfigsTable)
      .values({
        taskId: input.taskId,
        url: input.url,
        token: input.token ?? null,
        authScheme: input.authScheme ?? null,
        authCredentials: input.authCredentials
          ? encryptSecretValue({ credentials: input.authCredentials })
          : null,
      })
      .returning();

    return toRecord(row);
  }

  /** Replace an existing config in place (same id), for idempotent upserts. */
  static async update(params: {
    id: string;
    taskId: string;
    url: string;
    token?: string | null;
    authScheme?: string | null;
    authCredentials?: string | null;
  }): Promise<A2APushNotificationConfigRecord | null> {
    const [row] = await db
      .update(schema.a2aPushNotificationConfigsTable)
      .set({
        url: params.url,
        token: params.token ?? null,
        authScheme: params.authScheme ?? null,
        authCredentials: params.authCredentials
          ? encryptSecretValue({ credentials: params.authCredentials })
          : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.a2aPushNotificationConfigsTable.id, params.id),
          eq(schema.a2aPushNotificationConfigsTable.taskId, params.taskId),
        ),
      )
      .returning();

    return row ? toRecord(row) : null;
  }

  static async findByTaskId(
    taskId: string,
  ): Promise<A2APushNotificationConfigRecord[]> {
    const rows = await db
      .select()
      .from(schema.a2aPushNotificationConfigsTable)
      .where(eq(schema.a2aPushNotificationConfigsTable.taskId, taskId))
      .orderBy(schema.a2aPushNotificationConfigsTable.createdAt);

    return rows.map(toRecord);
  }

  static async findByIdForTask(params: {
    id: string;
    taskId: string;
  }): Promise<A2APushNotificationConfigRecord | null> {
    const [row] = await db
      .select()
      .from(schema.a2aPushNotificationConfigsTable)
      .where(
        and(
          eq(schema.a2aPushNotificationConfigsTable.id, params.id),
          eq(schema.a2aPushNotificationConfigsTable.taskId, params.taskId),
        ),
      )
      .limit(1);

    return row ? toRecord(row) : null;
  }

  /**
   * Configs plus their decrypted credentials, for the delivery worker only.
   * Never expose the result of this to a protocol response.
   */
  static async findDeliveryTargets(taskId: string): Promise<
    (A2APushNotificationConfigRecord & {
      authCredentials: string | null;
    })[]
  > {
    const rows = await db
      .select()
      .from(schema.a2aPushNotificationConfigsTable)
      .where(eq(schema.a2aPushNotificationConfigsTable.taskId, taskId))
      .orderBy(schema.a2aPushNotificationConfigsTable.createdAt);

    return rows.map((row) => ({
      ...toRecord(row),
      authCredentials: decryptCredentials(row.authCredentials),
    }));
  }

  static async delete(params: {
    id: string;
    taskId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.a2aPushNotificationConfigsTable)
      .where(
        and(
          eq(schema.a2aPushNotificationConfigsTable.id, params.id),
          eq(schema.a2aPushNotificationConfigsTable.taskId, params.taskId),
        ),
      )
      .returning({ id: schema.a2aPushNotificationConfigsTable.id });

    return deleted.length > 0;
  }
}

export default A2APushNotificationConfigModel;

// =============================================================================
// Internal helpers
// =============================================================================

function toRecord(row: {
  id: string;
  taskId: string;
  url: string;
  token: string | null;
  authScheme: string | null;
  createdAt: Date;
}): A2APushNotificationConfigRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    url: row.url,
    token: row.token,
    authScheme: row.authScheme,
    createdAt: row.createdAt,
  };
}

function decryptCredentials(
  encrypted: Record<string, unknown> | null,
): string | null {
  if (!encrypted) {
    return null;
  }
  const decrypted = decryptSecretValue(
    encrypted as Parameters<typeof decryptSecretValue>[0],
  );
  const credentials = (decrypted as { credentials?: unknown }).credentials;
  return typeof credentials === "string" ? credentials : null;
}
