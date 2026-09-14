import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  AgentActivationSkillMode,
  AgentActivationSkillReference,
  AgentActivationSkillRuleDisposition,
} from "@/types";

export type AgentActivationSkillPolicyRule = {
  disposition: AgentActivationSkillRuleDisposition;
  reference: AgentActivationSkillReference;
};

export type AgentActivationSkillPolicySnapshot = {
  mode: AgentActivationSkillMode;
  revision: number;
  rules: AgentActivationSkillPolicyRule[];
};

/** Pure persistence for exact internal-agent activation policy rules. */
class AgentActivationSkillRuleModel {
  static async findPolicySnapshot(
    agentId: string,
    tx?: Transaction,
  ): Promise<AgentActivationSkillPolicySnapshot | null> {
    const rows = await (tx ?? db)
      .select({
        mode: schema.agentsTable.activationSkillMode,
        revision: schema.agentsTable.activationSkillPolicyRevision,
        rule: schema.agentActivationSkillRulesTable,
      })
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentActivationSkillRulesTable,
        eq(
          schema.agentActivationSkillRulesTable.agentId,
          schema.agentsTable.id,
        ),
      )
      .where(
        and(eq(schema.agentsTable.id, agentId), notDeleted(schema.agentsTable)),
      )
      .orderBy(
        asc(schema.agentActivationSkillRulesTable.disposition),
        asc(schema.agentActivationSkillRulesTable.source),
        asc(schema.agentActivationSkillRulesTable.skillId),
        asc(schema.agentActivationSkillRulesTable.mcpServerId),
        asc(schema.agentActivationSkillRulesTable.uri),
        asc(schema.agentActivationSkillRulesTable.pluginId),
        asc(schema.agentActivationSkillRulesTable.skillPath),
      );
    const first = rows[0];
    if (!first) return null;
    return {
      mode: first.mode,
      revision: first.revision,
      rules: rows.flatMap(({ rule }) =>
        rule
          ? [{ disposition: rule.disposition, reference: rowToReference(rule) }]
          : [],
      ),
    };
  }

  static async findPolicySnapshots(
    agentIds: string[],
  ): Promise<Map<string, AgentActivationSkillPolicySnapshot>> {
    if (agentIds.length === 0) return new Map();
    const rows = await db
      .select({
        agentId: schema.agentsTable.id,
        mode: schema.agentsTable.activationSkillMode,
        revision: schema.agentsTable.activationSkillPolicyRevision,
        rule: schema.agentActivationSkillRulesTable,
      })
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentActivationSkillRulesTable,
        eq(
          schema.agentActivationSkillRulesTable.agentId,
          schema.agentsTable.id,
        ),
      )
      .where(
        and(
          inArray(schema.agentsTable.id, agentIds),
          notDeleted(schema.agentsTable),
        ),
      );
    const snapshots = new Map<string, AgentActivationSkillPolicySnapshot>();
    for (const row of rows) {
      const snapshot = snapshots.get(row.agentId) ?? {
        mode: row.mode,
        revision: row.revision,
        rules: [],
      };
      if (row.rule) {
        snapshot.rules.push({
          disposition: row.rule.disposition,
          reference: rowToReference(row.rule),
        });
      }
      snapshots.set(row.agentId, snapshot);
    }
    return snapshots;
  }

  static async findByAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<AgentActivationSkillPolicyRule[]> {
    const rows = await (tx ?? db)
      .select()
      .from(schema.agentActivationSkillRulesTable)
      .where(eq(schema.agentActivationSkillRulesTable.agentId, agentId))
      .orderBy(
        asc(schema.agentActivationSkillRulesTable.disposition),
        asc(schema.agentActivationSkillRulesTable.source),
        asc(schema.agentActivationSkillRulesTable.skillId),
        asc(schema.agentActivationSkillRulesTable.mcpServerId),
        asc(schema.agentActivationSkillRulesTable.uri),
        asc(schema.agentActivationSkillRulesTable.pluginId),
        asc(schema.agentActivationSkillRulesTable.skillPath),
      );
    return rows.map((row) => ({
      disposition: row.disposition,
      reference: rowToReference(row),
    }));
  }

  static async addRules(params: {
    agentId: string;
    rules: AgentActivationSkillPolicyRule[];
    tx?: Transaction;
  }): Promise<void> {
    if (params.rules.length === 0) return;
    await (params.tx ?? db)
      .insert(schema.agentActivationSkillRulesTable)
      .values(
        params.rules.map((rule) => ({
          agentId: params.agentId,
          disposition: rule.disposition,
          ...referenceToColumns(rule.reference),
        })),
      )
      .onConflictDoNothing();
  }

  static async replaceRules(params: {
    agentId: string;
    rules: AgentActivationSkillPolicyRule[];
    tx: Transaction;
  }): Promise<void> {
    await params.tx
      .delete(schema.agentActivationSkillRulesTable)
      .where(eq(schema.agentActivationSkillRulesTable.agentId, params.agentId));
    await AgentActivationSkillRuleModel.addRules({
      agentId: params.agentId,
      rules: params.rules,
      tx: params.tx,
    });
  }
}

function referenceToColumns(reference: AgentActivationSkillReference) {
  switch (reference.source) {
    case "native":
      return { source: reference.source, skillId: reference.skillId };
    case "external_mcp":
      return {
        source: reference.source,
        mcpServerId: reference.mcpServerId,
        uri: reference.uri,
      };
    case "plugin":
      return {
        source: reference.source,
        pluginId: reference.pluginId,
        skillPath: reference.skillPath,
      };
  }
}

function rowToReference(
  row: typeof schema.agentActivationSkillRulesTable.$inferSelect,
): AgentActivationSkillReference {
  switch (row.source) {
    case "native":
      if (!row.skillId) throw new Error("Invalid native activation skill rule");
      return { source: row.source, skillId: row.skillId };
    case "external_mcp":
      if (!row.mcpServerId || row.uri === null) {
        throw new Error("Invalid external MCP activation skill rule");
      }
      return {
        source: row.source,
        mcpServerId: row.mcpServerId,
        uri: row.uri,
      };
    case "plugin":
      if (!row.pluginId || row.skillPath === null) {
        throw new Error("Invalid plugin activation skill rule");
      }
      return {
        source: row.source,
        pluginId: row.pluginId,
        skillPath: row.skillPath,
      };
    default:
      throw new Error("Invalid activation skill rule source");
  }
}

export default AgentActivationSkillRuleModel;
