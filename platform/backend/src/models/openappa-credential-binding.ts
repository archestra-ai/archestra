import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { CredentialBinding } from "@/types/openappa-batteries";

const table = schema.openappaCredentialBindingsTable;

class OpenAppaCredentialBindingModel {
  static async list(organizationId: string): Promise<CredentialBinding[]> {
    return db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId))
      .orderBy(asc(table.variable));
  }

  static async find(params: {
    organizationId: string;
    variable: string;
  }): Promise<CredentialBinding | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.variable, params.variable),
        ),
      );
    return row ?? null;
  }

  static async upsert(params: {
    organizationId: string;
    variable: string;
    credentialKey: string;
    updatedBy: string | null;
  }): Promise<CredentialBinding> {
    const now = new Date();
    const [row] = await db
      .insert(table)
      .values(params)
      .onConflictDoUpdate({
        target: [table.organizationId, table.variable],
        set: {
          credentialKey: params.credentialKey,
          updatedBy: params.updatedBy,
          updatedAt: now,
        },
      })
      .returning();
    return row;
  }

  /** Insert the bindings whose variable has no row yet; existing rows are kept as they are. */
  static async insertMissing(params: {
    organizationId: string;
    bindings: ReadonlyArray<{ variable: string; credentialKey: string }>;
  }): Promise<number> {
    if (params.bindings.length === 0) return 0;
    const inserted = await db
      .insert(table)
      .values(
        params.bindings.map((binding) => ({
          organizationId: params.organizationId,
          updatedBy: null,
          ...binding,
        })),
      )
      .onConflictDoNothing({ target: [table.organizationId, table.variable] })
      .returning({ variable: table.variable });
    return inserted.length;
  }

  static async delete(params: {
    organizationId: string;
    variable: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.variable, params.variable),
        ),
      )
      .returning({ variable: table.variable });
    return deleted.length > 0;
  }

  /** A binding is identified by its variable within the organization. */
  static async findByIdForAudit(
    variable: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await OpenAppaCredentialBindingModel.find({
      organizationId,
      variable,
    });
    return row ? { variable: row.variable, key: row.credentialKey } : null;
  }
}

export default OpenAppaCredentialBindingModel;
