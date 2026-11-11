// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { and, asc, count, eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  FederatedCredentialClaimConditions,
  SelectServiceAccountFederatedCredential,
  ServiceAccountFederatedCredentialResponse,
  UpdateServiceAccountFederatedCredentialBody,
} from "@/types/service-account-federated-credential";

const table = schema.serviceAccountFederatedCredentialsTable;

class ServiceAccountFederatedCredentialModel {
  static readonly MAX_PER_SERVICE_ACCOUNT = 20;

  static async listForServiceAccount(params: {
    serviceAccountId: string;
    organizationId: string;
  }): Promise<ServiceAccountFederatedCredentialResponse[]> {
    const rows = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.serviceAccountId, params.serviceAccountId),
          eq(table.organizationId, params.organizationId),
        ),
      )
      .orderBy(asc(table.createdAt));
    return rows.map(toResponse);
  }

  static async countForServiceAccount(serviceAccountId: string) {
    const [row] = await db
      .select({ value: count() })
      .from(table)
      .where(eq(table.serviceAccountId, serviceAccountId));
    return row?.value ?? 0;
  }

  static async findById(params: {
    id: string;
    serviceAccountId: string;
    organizationId: string;
  }): Promise<ServiceAccountFederatedCredentialResponse | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.serviceAccountId, params.serviceAccountId),
          eq(table.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ? toResponse(row) : null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(and(eq(table.id, id), eq(table.organizationId, organizationId)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      serviceAccountId: row.serviceAccountId,
      name: row.name,
      issuer: row.issuer,
      audience: row.audience,
      subject: row.subject,
      claimConditions: row.claimConditions,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** The account's credentials for one issuer, compared exactly. */
  static async findForIssuer(params: {
    serviceAccountId: string;
    issuer: string;
  }): Promise<SelectServiceAccountFederatedCredential[]> {
    return db
      .select()
      .from(table)
      .where(
        and(
          eq(table.serviceAccountId, params.serviceAccountId),
          eq(table.issuer, params.issuer),
        ),
      )
      .orderBy(asc(table.createdAt));
  }

  static async isNameTaken(params: {
    serviceAccountId: string;
    name: string;
    excludeId?: string;
  }): Promise<boolean> {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.serviceAccountId, params.serviceAccountId),
          eq(table.name, params.name),
        ),
      )
      .limit(2);
    return rows.some((row) => row.id !== params.excludeId);
  }

  static async create(params: {
    organizationId: string;
    serviceAccountId: string;
    name: string;
    issuer: string;
    audience: string;
    subject: string;
    claimConditions: FederatedCredentialClaimConditions;
    createdBy: string | null;
  }): Promise<ServiceAccountFederatedCredentialResponse> {
    const [row] = await db.insert(table).values(params).returning();
    return toResponse(row);
  }

  /**
   * Update a credential. When anything that decides which tokens it trusts
   * changes, the tokens it already issued are revoked with the same write, so
   * a narrowed policy takes effect at once rather than when they expire.
   */
  static async update(params: {
    id: string;
    serviceAccountId: string;
    organizationId: string;
    data: UpdateServiceAccountFederatedCredentialBody;
  }): Promise<ServiceAccountFederatedCredentialResponse | null> {
    return withDbTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.id, params.id),
            eq(table.serviceAccountId, params.serviceAccountId),
            eq(table.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      if (!existing) return null;
      if (Object.keys(params.data).length === 0) return toResponse(existing);

      const [updated] = await tx
        .update(table)
        .set(params.data)
        .where(eq(table.id, params.id))
        .returning();

      if (trustChanged(existing, updated)) {
        await tx
          .delete(schema.serviceAccountTokensTable)
          .where(
            eq(
              schema.serviceAccountTokensTable.federatedCredentialId,
              params.id,
            ),
          );
      }
      return toResponse(updated);
    });
  }

  /** Deleting a credential revokes the tokens it issued (ON DELETE CASCADE). */
  static async delete(params: {
    id: string;
    serviceAccountId: string;
    organizationId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.serviceAccountId, params.serviceAccountId),
          eq(table.organizationId, params.organizationId),
        ),
      )
      .returning({ id: table.id });
    return deleted.length > 0;
  }

  static async markUsed(id: string): Promise<void> {
    await db
      .update(table)
      .set({ lastUsedAt: new Date() })
      .where(eq(table.id, id));
  }
}

export default ServiceAccountFederatedCredentialModel;

// === Internal helpers

function toResponse(
  row: typeof table.$inferSelect,
): ServiceAccountFederatedCredentialResponse {
  return {
    id: row.id,
    serviceAccountId: row.serviceAccountId,
    name: row.name,
    issuer: row.issuer,
    audience: row.audience,
    subject: row.subject,
    claimConditions: row.claimConditions,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function trustChanged(
  before: typeof table.$inferSelect,
  after: typeof table.$inferSelect,
): boolean {
  return (
    before.issuer !== after.issuer ||
    before.audience !== after.audience ||
    before.subject !== after.subject ||
    JSON.stringify(sortedEntries(before.claimConditions)) !==
      JSON.stringify(sortedEntries(after.claimConditions))
  );
}

function sortedEntries(conditions: FederatedCredentialClaimConditions) {
  return Object.entries(conditions).sort(([a], [b]) => a.localeCompare(b));
}
