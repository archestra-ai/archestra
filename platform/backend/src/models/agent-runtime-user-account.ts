import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentRuntimeAccountAuthentication,
  AgentRuntimeUserAccount,
} from "@/types/agent-runtime-user-account";

/** Each person's own account choice for their Agent Runtime runs of an agent. */
class AgentRuntimeUserAccountModel {
  static async find(params: {
    agentId: string;
    userId: string;
  }): Promise<AgentRuntimeUserAccount | null> {
    const [row] = await db
      .select()
      .from(schema.agentRuntimeUserAccountsTable)
      .where(where(params));
    return row ?? null;
  }

  static async upsert(params: {
    agentId: string;
    userId: string;
    authentication: AgentRuntimeAccountAuthentication;
    /** The connection picked for the company API key; none unless given. */
    llmApiKeyId?: string | null;
    modelId: string | null;
    /** A Claude subscription's own model; none unless given. */
    claudeModel?: string | null;
  }): Promise<AgentRuntimeUserAccount> {
    const { agentId, userId, ...given } = params;
    // A new choice replaces the whole row, an earlier connection and Claude
    // model included.
    const choice = {
      ...given,
      llmApiKeyId: given.llmApiKeyId ?? null,
      claudeModel: given.claudeModel ?? null,
    };
    const [row] = await db
      .insert(schema.agentRuntimeUserAccountsTable)
      .values({ agentId, userId, ...choice })
      .onConflictDoUpdate({
        target: [
          schema.agentRuntimeUserAccountsTable.agentId,
          schema.agentRuntimeUserAccountsTable.userId,
        ],
        set: { ...choice, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /** Idempotent: true when a choice was removed. */
  static async delete(params: {
    agentId: string;
    userId: string;
  }): Promise<boolean> {
    const rows = await db
      .delete(schema.agentRuntimeUserAccountsTable)
      .where(where(params))
      .returning({ agentId: schema.agentRuntimeUserAccountsTable.agentId });
    return rows.length > 0;
  }
}

export default AgentRuntimeUserAccountModel;

function where(params: { agentId: string; userId: string }) {
  return and(
    eq(schema.agentRuntimeUserAccountsTable.agentId, params.agentId),
    eq(schema.agentRuntimeUserAccountsTable.userId, params.userId),
  );
}
