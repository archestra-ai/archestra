import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { JiraChatOpsIdentity } from "@/types/jira-chatops-identity";

class JiraChatOpsIdentityModel {
  static async find(params: {
    integrationId: string;
    organizationId: string;
    accountId: string;
  }): Promise<JiraChatOpsIdentity | null> {
    const table = schema.jiraChatOpsIdentitiesTable;
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.integrationId, params.integrationId),
          eq(table.organizationId, params.organizationId),
          eq(table.accountId, params.accountId),
        ),
      );
    return row ?? null;
  }

  /** First verified observation wins; no rebind, including deleted-user tombstones. */
  static async remember(params: {
    integrationId: string;
    organizationId: string;
    accountId: string;
    userId: string;
  }): Promise<JiraChatOpsIdentity> {
    if (!params.accountId || params.accountId.length > 256)
      throw new Error("Invalid Jira account identity");
    const table = schema.jiraChatOpsIdentitiesTable;
    return db.transaction(async (tx) => {
      await tx.insert(table).values(params).onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.integrationId, params.integrationId),
            eq(table.accountId, params.accountId),
          ),
        );
      if (
        !row ||
        row.organizationId !== params.organizationId ||
        row.userId !== params.userId
      )
        throw new Error("Jira human identity association conflict");
      return row;
    });
  }
}

export default JiraChatOpsIdentityModel;
