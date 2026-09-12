import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import db, { schema, withDbTransaction } from "@/database";
import { ClaudeCodeModelsSchema } from "@/types/claude-code-account";

/** Claude connections follow a user across Agents through runtime_credential_connections. Pending sign-ins use expiring
 * verification records; neither stores the credential value itself. */
class ClaudeCodeAccountModel {
  static async find(owner: Owner) {
    const [row] = await db
      .select()
      .from(schema.runtimeCredentialConnectionsTable)
      .where(ownerWhere(owner));
    if (!row) return null;
    const metadata = MetadataSchema.safeParse(row.metadata);
    return metadata.success ? { ...row, ...metadata.data } : null;
  }

  static async flow(owner: Owner) {
    const [row] = await db
      .select()
      .from(schema.verificationsTable)
      .where(eq(schema.verificationsTable.id, flowKey(owner)));
    if (!row) return null;
    const value = FlowSchema.safeParse(JSON.parse(row.value));
    return value.success ? { ...value.data, expiresAt: row.expiresAt } : null;
  }

  static async startFlow(params: {
    owner: Owner;
    flow: z.infer<typeof FlowSchema>;
  }) {
    const identifier = flowKey(params.owner);
    const value = JSON.stringify(params.flow);
    const expiresAt = new Date(Date.now() + 600_000);
    await db
      .insert(schema.verificationsTable)
      .values({ id: identifier, identifier, value, expiresAt })
      .onConflictDoUpdate({
        target: schema.verificationsTable.id,
        set: { value, expiresAt },
      });
  }

  static async complete(params: {
    owner: Owner;
    flowId: string;
    secretId: string;
    metadata: z.infer<typeof MetadataSchema>;
  }) {
    return withDbTransaction(async (tx) => {
      const [flow] = await tx
        .select()
        .from(schema.verificationsTable)
        .where(eq(schema.verificationsTable.id, flowKey(params.owner)))
        .for("update");
      if (
        !flow ||
        flow.expiresAt <= new Date() ||
        FlowSchema.parse(JSON.parse(flow.value)).flowId !== params.flowId
      )
        return null;
      const [previous] = await tx
        .select()
        .from(schema.runtimeCredentialConnectionsTable)
        .where(ownerWhere(params.owner));
      const [account] = await tx
        .insert(schema.runtimeCredentialConnectionsTable)
        .values({
          organizationId: params.owner.organizationId,
          userId: params.owner.userId,
          scope: "personal",
          credentialId: CREDENTIAL_ID,
          secretId: params.secretId,
          metadata: params.metadata,
        })
        .onConflictDoUpdate({
          target: [
            schema.runtimeCredentialConnectionsTable.organizationId,
            schema.runtimeCredentialConnectionsTable.userId,
            schema.runtimeCredentialConnectionsTable.credentialId,
          ],
          targetWhere: sql`scope = 'personal'`,
          set: { secretId: params.secretId, metadata: params.metadata },
        })
        .returning();
      await tx
        .delete(schema.verificationsTable)
        .where(eq(schema.verificationsTable.id, flow.id));
      return { account, previousSecretId: previous?.secretId ?? null };
    });
  }

  static async delete(owner: Owner) {
    return withDbTransaction(async (tx) => {
      // This deletion takes the same row lock as complete(). Whichever wins,
      // completion cannot restore a connection after disconnect has committed.
      const [pending] = await tx
        .delete(schema.verificationsTable)
        .where(eq(schema.verificationsTable.id, flowKey(owner)))
        .returning();
      const [account] = await tx
        .delete(schema.runtimeCredentialConnectionsTable)
        .where(ownerWhere(owner))
        .returning();
      return {
        account: account ?? null,
        flow: pending ? FlowSchema.parse(JSON.parse(pending.value)) : null,
      };
    });
  }
}

export default ClaudeCodeAccountModel;

type Owner = { organizationId: string; userId: string };
// The colon is reserved: user-defined credential IDs cannot bind this account
// into arbitrary runtime environment variables.
const CREDENTIAL_ID = "claude-code:account";
const MetadataSchema = ClaudeCodeModelsSchema.extend({
  image: z.string(),
  expiresAt: z.string().datetime().nullable(),
});
const FlowSchema = z.object({
  flowId: z.string().uuid(),
  namespace: z.string(),
  image: z.string(),
  vaultReference: z.string().optional(),
});
function flowKey(owner: Owner) {
  return `claude-code-sign-in:${createHash("sha256")
    .update(JSON.stringify([owner.organizationId, owner.userId]))
    .digest("hex")}`;
}
function ownerWhere(owner: Owner) {
  const table = schema.runtimeCredentialConnectionsTable;
  return and(
    eq(table.organizationId, owner.organizationId),
    eq(table.userId, owner.userId),
    eq(table.scope, "personal"),
    eq(table.credentialId, CREDENTIAL_ID),
  );
}
