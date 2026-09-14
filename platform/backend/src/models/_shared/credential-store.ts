import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { RuntimeCredentialDefinition } from "@/types";

export async function listSharedCredentials(params: {
  organizationId: string;
  kind: RuntimeCredentialDefinition["kind"];
  id?: string;
}) {
  const query = db
    .select({
      definition: schema.runtimeCredentialDefinitionsTable,
      secretId: schema.runtimeCredentialConnectionsTable.secretId,
    })
    .from(schema.runtimeCredentialDefinitionsTable)
    .leftJoin(
      schema.runtimeCredentialConnectionsTable,
      and(
        eq(
          schema.runtimeCredentialConnectionsTable.organizationId,
          schema.runtimeCredentialDefinitionsTable.organizationId,
        ),
        eq(
          schema.runtimeCredentialConnectionsTable.credentialId,
          schema.runtimeCredentialDefinitionsTable.key,
        ),
        eq(schema.runtimeCredentialConnectionsTable.scope, "organization"),
      ),
    )
    .where(
      and(
        eq(
          schema.runtimeCredentialDefinitionsTable.organizationId,
          params.organizationId,
        ),
        eq(schema.runtimeCredentialDefinitionsTable.kind, params.kind),
        params.id !== undefined
          ? eq(schema.runtimeCredentialDefinitionsTable.id, params.id)
          : undefined,
        eq(schema.runtimeCredentialDefinitionsTable.allowOrganization, true),
      ),
    );
  return params.id !== undefined ? query.limit(1) : query;
}

export async function createSharedCredential(data: {
  id?: string;
  organizationId: string;
  name: string;
  kind: RuntimeCredentialDefinition["kind"];
  secretId?: string | null;
  githubUrl?: string | null;
  appId?: string | null;
  installationId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return db.transaction(async (tx) => {
    const id = data.id ?? crypto.randomUUID();
    const { secretId, ...definition } = data;
    const [created] = await tx
      .insert(schema.runtimeCredentialDefinitionsTable)
      .values({
        ...definition,
        id,
        key: `${data.kind.replaceAll("_", "-")}.${id}`,
        allowPersonal: false,
        allowOrganization: true,
      })
      .returning();
    if (secretId)
      await tx.insert(schema.runtimeCredentialConnectionsTable).values({
        organizationId: data.organizationId,
        credentialId: created.key,
        scope: "organization",
        userId: null,
        secretId,
        secretKey: "apiToken",
      });
    return created;
  });
}

export async function updateSharedCredential(
  id: string,
  data: {
    name?: string;
    secretId?: string | null;
    githubUrl?: string;
    appId?: string;
    installationId?: string;
  },
) {
  return db.transaction(async (tx) => {
    const { secretId, ...patch } = data;
    const [updated] = await tx
      .update(schema.runtimeCredentialDefinitionsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.runtimeCredentialDefinitionsTable.id, id))
      .returning();
    if (!updated) return null;
    if (secretId) {
      const [connection] = await tx
        .select()
        .from(schema.runtimeCredentialConnectionsTable)
        .where(
          and(
            eq(
              schema.runtimeCredentialConnectionsTable.organizationId,
              updated.organizationId,
            ),
            eq(
              schema.runtimeCredentialConnectionsTable.credentialId,
              updated.key,
            ),
            eq(schema.runtimeCredentialConnectionsTable.scope, "organization"),
          ),
        );
      if (connection)
        await tx
          .update(schema.runtimeCredentialConnectionsTable)
          .set({ secretId, secretKey: "apiToken", updatedAt: new Date() })
          .where(
            eq(schema.runtimeCredentialConnectionsTable.id, connection.id),
          );
      else
        await tx.insert(schema.runtimeCredentialConnectionsTable).values({
          organizationId: updated.organizationId,
          credentialId: updated.key,
          scope: "organization",
          userId: null,
          secretId,
          secretKey: "apiToken",
        });
    }
    return updated;
  });
}

export async function deleteSharedCredential(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(schema.runtimeCredentialDefinitionsTable)
      .where(eq(schema.runtimeCredentialDefinitionsTable.id, id))
      .returning();
    if (!deleted) return false;
    await tx
      .delete(schema.runtimeCredentialConnectionsTable)
      .where(
        and(
          eq(
            schema.runtimeCredentialConnectionsTable.organizationId,
            deleted.organizationId,
          ),
          eq(
            schema.runtimeCredentialConnectionsTable.credentialId,
            deleted.key,
          ),
        ),
      );
    return true;
  });
}
