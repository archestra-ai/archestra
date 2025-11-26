import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  CreateSsoProvider,
  InsertSsoProvider,
  SsoProvider,
  UpdateSsoProvider,
} from "@/types";

// Generate a base62 ID similar to Better Auth's ID generation
const generateId = (): string => {
  const bytes = randomBytes(12);
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
};

class SsoProviderModel {
  static async create(
    organizationId: string,
    data: CreateSsoProvider,
  ): Promise<SsoProvider> {
    const id = generateId();

    const [provider] = await db
      .insert(schema.ssoProviderTable)
      .values({
        id,
        organizationId,
        ...data,
      })
      .returning();

    return provider;
  }

  static async getById(id: string): Promise<SsoProvider | null> {
    const [provider] = await db
      .select()
      .from(schema.ssoProviderTable)
      .where(eq(schema.ssoProviderTable.id, id))
      .limit(1);

    return provider || null;
  }

  static async getByOrganizationId(
    organizationId: string,
  ): Promise<SsoProvider[]> {
    return db
      .select()
      .from(schema.ssoProviderTable)
      .where(eq(schema.ssoProviderTable.organizationId, organizationId));
  }

  static async getEnabledByOrganizationId(
    organizationId: string,
  ): Promise<SsoProvider[]> {
    return db
      .select()
      .from(schema.ssoProviderTable)
      .where(
        and(
          eq(schema.ssoProviderTable.organizationId, organizationId),
          eq(schema.ssoProviderTable.enabled, true),
        ),
      );
  }

  static async update(
    id: string,
    organizationId: string,
    data: UpdateSsoProvider,
  ): Promise<SsoProvider | null> {
    const [updated] = await db
      .update(schema.ssoProviderTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.ssoProviderTable.id, id),
          eq(schema.ssoProviderTable.organizationId, organizationId),
        ),
      )
      .returning();

    return updated || null;
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    const result = await db
      .delete(schema.ssoProviderTable)
      .where(
        and(
          eq(schema.ssoProviderTable.id, id),
          eq(schema.ssoProviderTable.organizationId, organizationId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default SsoProviderModel;
