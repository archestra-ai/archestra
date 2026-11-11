import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { BlobProviderConfig, BlobProviderRow } from "@/types";

class BlobProviderModel {
  static async findByOrganization(
    organizationId: string,
  ): Promise<BlobProviderRow[]> {
    return db
      .select()
      .from(schema.blobProvidersTable)
      .where(eq(schema.blobProvidersTable.organizationId, organizationId))
      .orderBy(asc(schema.blobProvidersTable.name));
  }

  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<BlobProviderRow | null> {
    const [row] = await db
      .select()
      .from(schema.blobProvidersTable)
      .where(
        and(
          eq(schema.blobProvidersTable.id, params.id),
          eq(schema.blobProvidersTable.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  static async findByName(params: {
    name: string;
    organizationId: string;
  }): Promise<BlobProviderRow | null> {
    const [row] = await db
      .select()
      .from(schema.blobProvidersTable)
      .where(
        and(
          eq(schema.blobProvidersTable.name, params.name),
          eq(schema.blobProvidersTable.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  static async create(data: {
    organizationId: string;
    name: string;
    config: BlobProviderConfig;
    secretId: string | null;
  }): Promise<BlobProviderRow> {
    const [row] = await db
      .insert(schema.blobProvidersTable)
      .values({ ...data, type: data.config.type })
      .returning();
    return row;
  }

  static async update(
    params: { id: string; organizationId: string },
    data: {
      name?: string;
      config?: BlobProviderConfig;
      secretId?: string | null;
    },
  ): Promise<BlobProviderRow | null> {
    const [row] = await db
      .update(schema.blobProvidersTable)
      .set({
        ...data,
        ...(data.config ? { type: data.config.type } : {}),
      })
      .where(
        and(
          eq(schema.blobProvidersTable.id, params.id),
          eq(schema.blobProvidersTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const rows = await db
      .delete(schema.blobProvidersTable)
      .where(
        and(
          eq(schema.blobProvidersTable.id, params.id),
          eq(schema.blobProvidersTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.blobProvidersTable.id });
    return rows.length > 0;
  }

  /** Audit snapshot: the settings, never the secret reference. */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await BlobProviderModel.findById({ id, organizationId });
    if (!row) return null;
    const { secretId, ...snapshot } = row;
    return { ...snapshot, hasCredentials: secretId !== null };
  }
}

export default BlobProviderModel;
