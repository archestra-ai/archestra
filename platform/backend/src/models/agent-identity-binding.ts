// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { and, asc, eq, sql } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { AgentIdentityBinding } from "@/types/agent-identity-binding";

/**
 * Data access for the identity each agent acts as at an identity provider.
 * Who may change a binding, and which values a provider takes, is decided in
 * services/identity-providers/enterprise-managed/agent-identity.ts.
 */
class AgentIdentityBindingModel {
  static async findForAgent(agentId: string): Promise<AgentIdentityBinding[]> {
    return db
      .select({
        identityProviderId:
          schema.agentIdentityBindingsTable.identityProviderId,
        externalId: schema.agentIdentityBindingsTable.externalId,
      })
      .from(schema.agentIdentityBindingsTable)
      .where(eq(schema.agentIdentityBindingsTable.agentId, agentId))
      .orderBy(asc(schema.agentIdentityBindingsTable.identityProviderId));
  }

  /** The identity the agent acts as at one identity provider, if any. */
  static async findExternalId(params: {
    agentId: string;
    identityProviderId: string;
  }): Promise<string | null> {
    const [row] = await db
      .select({ externalId: schema.agentIdentityBindingsTable.externalId })
      .from(schema.agentIdentityBindingsTable)
      .where(
        and(
          eq(schema.agentIdentityBindingsTable.agentId, params.agentId),
          eq(
            schema.agentIdentityBindingsTable.identityProviderId,
            params.identityProviderId,
          ),
        ),
      )
      .limit(1);
    return row?.externalId ?? null;
  }

  /** The agent an identity at a provider is bound to. IDs compare case-insensitively. */
  static async findAgentIdByExternalId(params: {
    identityProviderId: string;
    externalId: string;
  }): Promise<string | null> {
    const [row] = await db
      .select({ agentId: schema.agentIdentityBindingsTable.agentId })
      .from(schema.agentIdentityBindingsTable)
      .where(
        and(
          eq(
            schema.agentIdentityBindingsTable.identityProviderId,
            params.identityProviderId,
          ),
          sql`lower(${schema.agentIdentityBindingsTable.externalId}) = ${params.externalId.toLowerCase()}`,
        ),
      )
      .limit(1);
    return row?.agentId ?? null;
  }

  /** Replaces the agent's bindings with `bindings`, atomically. */
  static async replaceForAgent(params: {
    agentId: string;
    bindings: AgentIdentityBinding[];
  }): Promise<void> {
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.agentIdentityBindingsTable)
        .where(eq(schema.agentIdentityBindingsTable.agentId, params.agentId));
      if (params.bindings.length === 0) return;
      await tx.insert(schema.agentIdentityBindingsTable).values(
        params.bindings.map((binding) => ({
          agentId: params.agentId,
          identityProviderId: binding.identityProviderId,
          externalId: binding.externalId,
        })),
      );
    });
  }
}

export default AgentIdentityBindingModel;
