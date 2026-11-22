import { and, eq } from "drizzle-orm";
import db from "@/database";
import agentRuntimeUserAccountsTable from "@/database/agent-runtime-user-accounts";
import type {
  AgentRuntimeAccountAuthentication,
  AgentRuntimeUserAccount,
} from "@/types/agent-runtime-user-account";

/** Each person's own account choice for their Agent Runtime runs of an agent. */
class AgentRuntimeUserAccountModel {
  /**
   * Whether the table exists for this process. The startup upgrade clears it
   * when it cannot create the table: until a restart creates it, nobody has
   * a choice, and every run uses the agent's own account, as before.
   */
  static tableAvailable = true;

  static async find(params: {
    agentId: string;
    userId: string;
  }): Promise<AgentRuntimeUserAccount | null> {
    if (!AgentRuntimeUserAccountModel.tableAvailable) return null;
    const [row] = await db
      .select()
      .from(agentRuntimeUserAccountsTable)
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
      .insert(agentRuntimeUserAccountsTable)
      .values({ agentId, userId, ...choice })
      .onConflictDoUpdate({
        target: [
          agentRuntimeUserAccountsTable.agentId,
          agentRuntimeUserAccountsTable.userId,
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
    if (!AgentRuntimeUserAccountModel.tableAvailable) return false;
    const rows = await db
      .delete(agentRuntimeUserAccountsTable)
      .where(where(params))
      .returning({ agentId: agentRuntimeUserAccountsTable.agentId });
    return rows.length > 0;
  }
}

export default AgentRuntimeUserAccountModel;

function where(params: { agentId: string; userId: string }) {
  return and(
    eq(agentRuntimeUserAccountsTable.agentId, params.agentId),
    eq(agentRuntimeUserAccountsTable.userId, params.userId),
  );
}
