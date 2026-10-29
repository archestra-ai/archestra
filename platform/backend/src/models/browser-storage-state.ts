import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import { decryptSecretValue, encryptSecretValue } from "@/utils/crypto";

class BrowserStorageStateModel {
  /**
   * The user's saved storageState JSON, or null when none is saved or it can
   * no longer be decrypted (the user then simply logs in again).
   */
  static async get(userId: string): Promise<string | null> {
    const [row] = await db
      .select({
        encryptedState: schema.browserStorageStatesTable.encryptedState,
      })
      .from(schema.browserStorageStatesTable)
      .where(eq(schema.browserStorageStatesTable.userId, userId))
      .limit(1);
    if (!row) return null;
    return decryptState(row.encryptedState, userId);
  }

  static async upsert(userId: string, state: string): Promise<void> {
    const encryptedState = encryptSecretValue({ state });
    await db
      .insert(schema.browserStorageStatesTable)
      .values({ userId, encryptedState })
      .onConflictDoUpdate({
        target: schema.browserStorageStatesTable.userId,
        set: { encryptedState, updatedAt: new Date() },
      });
  }

  /**
   * Overwrite the user's saved state only while a row exists. Returns false
   * when there is none, e.g. after an admin signed the user out.
   */
  static async update(userId: string, state: string): Promise<boolean> {
    const encryptedState = encryptSecretValue({ state });
    const rows = await db
      .update(schema.browserStorageStatesTable)
      .set({ encryptedState, updatedAt: new Date() })
      .where(eq(schema.browserStorageStatesTable.userId, userId))
      .returning({ userId: schema.browserStorageStatesTable.userId });
    return rows.length > 0;
  }

  /**
   * Saved logins of the organization's members, newest first. Exposes counts
   * and sizes only, never cookie names, values or domains.
   */
  static async listForOrganization(
    organizationId: string,
  ): Promise<SavedLogin[]> {
    return selectSavedLogins({ organizationId });
  }

  /** Audit snapshot of a member's saved login, keyed by user id. No secrets. */
  static async findByIdForAudit(
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [login] = await selectSavedLogins({ organizationId, userId });
    if (!login) return null;
    return {
      userId: login.userId,
      email: login.email,
      siteCount: login.siteCount,
      sizeBytes: login.sizeBytes,
      updatedAt: login.updatedAt.toISOString(),
    };
  }

  /**
   * Delete a member's saved state. Returns false when the user is not a member
   * of the organization or has nothing saved.
   */
  static async deleteForOrganization(params: {
    userId: string;
    organizationId: string;
  }): Promise<boolean> {
    const { userId, organizationId } = params;
    const [member] = await db
      .select({ id: schema.membersTable.id })
      .from(schema.membersTable)
      .where(
        and(
          eq(schema.membersTable.userId, userId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!member) return false;

    const rows = await db
      .delete(schema.browserStorageStatesTable)
      .where(eq(schema.browserStorageStatesTable.userId, userId))
      .returning({ userId: schema.browserStorageStatesTable.userId });
    return rows.length > 0;
  }
}

export default BrowserStorageStateModel;

// ===

type SavedLogin = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  siteCount: number;
  sizeBytes: number;
  updatedAt: Date;
};

async function selectSavedLogins(params: {
  organizationId: string;
  userId?: string;
}): Promise<SavedLogin[]> {
  const { organizationId, userId } = params;
  const rows = await db
    .select({
      userId: schema.browserStorageStatesTable.userId,
      encryptedState: schema.browserStorageStatesTable.encryptedState,
      updatedAt: schema.browserStorageStatesTable.updatedAt,
      name: schema.usersTable.name,
      email: schema.usersTable.email,
      image: schema.usersTable.image,
    })
    .from(schema.browserStorageStatesTable)
    .innerJoin(
      schema.usersTable,
      eq(schema.usersTable.id, schema.browserStorageStatesTable.userId),
    )
    .innerJoin(
      schema.membersTable,
      and(
        eq(schema.membersTable.userId, schema.browserStorageStatesTable.userId),
        eq(schema.membersTable.organizationId, organizationId),
      ),
    )
    .where(
      userId ? eq(schema.browserStorageStatesTable.userId, userId) : undefined,
    )
    .orderBy(desc(schema.browserStorageStatesTable.updatedAt));

  return rows.map(({ encryptedState, ...row }) => {
    const state = decryptState(encryptedState, row.userId);
    return {
      ...row,
      siteCount: state ? countSites(state) : 0,
      sizeBytes: state ? Buffer.byteLength(state) : 0,
    };
  });
}

function decryptState(
  encryptedState: { __encrypted: string },
  userId: string,
): string | null {
  try {
    const { state } = decryptSecretValue(encryptedState);
    return typeof state === "string" ? state : null;
  } catch (error) {
    logger.warn(
      { userId, error },
      "[BrowserStorageState] Saved browser state could not be decrypted; ignoring it",
    );
    return null;
  }
}

/** Distinct hosts the state holds cookies or localStorage for. */
function countSites(state: string): number {
  try {
    const parsed = JSON.parse(state) as {
      cookies?: Array<{ domain?: string }>;
      origins?: Array<{ origin?: string }>;
    };
    const hosts = new Set<string>();
    for (const { domain } of parsed.cookies ?? []) {
      if (domain) hosts.add(domain.replace(/^\./, ""));
    }
    for (const { origin } of parsed.origins ?? []) {
      if (!origin) continue;
      try {
        hosts.add(new URL(origin).hostname);
      } catch {
        // Ignore malformed origins
      }
    }
    return hosts.size;
  } catch {
    return 0;
  }
}
