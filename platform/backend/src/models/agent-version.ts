import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";
import type { AgentConfigSnapshot, AgentVersion } from "@/types/agent-version";

type AgentRow = typeof schema.agentsTable.$inferSelect;

/**
 * Owns immutable agent config snapshots (`agent_versions`). Config-mutating
 * operations fork a new version at their boundary via `forkIfChangedBestEffort`
 * when the write changes the canonical payload (see AgentConfigSnapshotSchema
 * for the exact surface): agent create/update, tool assign/unassign/delegation,
 * hook create/update/delete, tool/subagent exclusion edits, and knowledge/
 * connector assignment. A write producing an identical payload leaves the head
 * untouched (content-hash dedup).
 *
 * Coverage is at those operation boundaries, not a DB trigger — a write that
 * bypasses them (e.g. the bulk MCP-server install tool fan-out, which runs
 * inside its own transaction) is captured lazily by the next fork rather than
 * eagerly at the moment it happens.
 */
class AgentVersionModel {
  /**
   * sha256 over the canonical snapshot. Two writes that produce identical
   * config hash equal, which is how `forkIfChanged` suppresses no-op forks.
   */
  static computeContentHash(snapshot: AgentConfigSnapshot): string {
    return createHash("sha256").update(stableStringify(snapshot)).digest("hex");
  }

  /**
   * Assemble the agent's canonical config snapshot. Queries run through the
   * caller's transaction so the snapshot sees that transaction's own
   * uncommitted config writes. Every collection is sorted deterministically —
   * the snapshot is hashed, and row order from the DB is unspecified.
   */
  static async buildConfigSnapshot(
    tx: Transaction,
    agent: AgentRow,
  ): Promise<AgentConfigSnapshot> {
    const [
      tools,
      excludedTools,
      excludedSubagents,
      suggestedPrompts,
      hooks,
      knowledgeBases,
      connectors,
      modelRows,
      keyRows,
    ] = await Promise.all([
      tx
        .select({
          toolId: schema.agentToolsTable.toolId,
          name: schema.toolsTable.name,
          mcpServerId: schema.agentToolsTable.mcpServerId,
          credentialResolutionMode:
            schema.agentToolsTable.credentialResolutionMode,
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(eq(schema.agentToolsTable.agentId, agent.id)),
      tx
        .select({
          toolId: schema.agentExcludedToolsTable.toolId,
          name: schema.toolsTable.name,
        })
        .from(schema.agentExcludedToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentExcludedToolsTable.toolId, schema.toolsTable.id),
        )
        .where(eq(schema.agentExcludedToolsTable.agentId, agent.id)),
      tx
        .select({
          agentId: schema.agentExcludedSubagentsTable.targetAgentId,
          name: schema.agentsTable.name,
        })
        .from(schema.agentExcludedSubagentsTable)
        .innerJoin(
          schema.agentsTable,
          eq(
            schema.agentExcludedSubagentsTable.targetAgentId,
            schema.agentsTable.id,
          ),
        )
        .where(eq(schema.agentExcludedSubagentsTable.agentId, agent.id)),
      tx
        .select({
          summaryTitle: schema.agentSuggestedPromptsTable.summaryTitle,
          prompt: schema.agentSuggestedPromptsTable.prompt,
        })
        .from(schema.agentSuggestedPromptsTable)
        .where(eq(schema.agentSuggestedPromptsTable.agentId, agent.id))
        .orderBy(asc(schema.agentSuggestedPromptsTable.sortOrder)),
      tx
        .select({
          event: schema.hookFilesTable.event,
          fileName: schema.hookFilesTable.fileName,
          content: schema.hookFilesTable.content,
          requirements: schema.hookFilesTable.requirements,
          enabled: schema.hookFilesTable.enabled,
        })
        .from(schema.hookFilesTable)
        .where(eq(schema.hookFilesTable.agentId, agent.id)),
      tx
        .select({
          id: schema.agentKnowledgeBasesTable.knowledgeBaseId,
          name: schema.knowledgeBasesTable.name,
        })
        .from(schema.agentKnowledgeBasesTable)
        .innerJoin(
          schema.knowledgeBasesTable,
          eq(
            schema.agentKnowledgeBasesTable.knowledgeBaseId,
            schema.knowledgeBasesTable.id,
          ),
        )
        .where(eq(schema.agentKnowledgeBasesTable.agentId, agent.id)),
      tx
        .select({
          id: schema.agentConnectorAssignmentsTable.connectorId,
          name: schema.knowledgeBaseConnectorsTable.name,
        })
        .from(schema.agentConnectorAssignmentsTable)
        .innerJoin(
          schema.knowledgeBaseConnectorsTable,
          eq(
            schema.agentConnectorAssignmentsTable.connectorId,
            schema.knowledgeBaseConnectorsTable.id,
          ),
        )
        .where(eq(schema.agentConnectorAssignmentsTable.agentId, agent.id)),
      agent.modelId
        ? tx
            .select({ externalId: schema.modelsTable.externalId })
            .from(schema.modelsTable)
            .where(eq(schema.modelsTable.id, agent.modelId))
            .limit(1)
        : Promise.resolve([]),
      // Redacted key identity (never key material) so an LLM-config change is
      // legible in history — mirrors findByIdForAudit.
      agent.llmApiKeyId
        ? tx
            .select({
              id: schema.llmProviderApiKeysTable.id,
              name: schema.llmProviderApiKeysTable.name,
              provider: schema.llmProviderApiKeysTable.provider,
            })
            .from(schema.llmProviderApiKeysTable)
            .where(eq(schema.llmProviderApiKeysTable.id, agent.llmApiKeyId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    return {
      agentType: agent.agentType,
      name: agent.name,
      description: agent.description ?? null,
      icon: agent.icon ?? null,
      systemPrompt: agent.systemPrompt ?? null,
      considerContextUntrusted: agent.considerContextUntrusted,
      toolExposureMode: agent.toolExposureMode,
      accessAllTools: agent.accessAllTools,
      accessAllSubagents: agent.accessAllSubagents,
      // Header NAMES only (no values); order is not meaningful.
      passthroughHeaders: [...(agent.passthroughHeaders ?? [])].sort(),
      incomingEmailEnabled: agent.incomingEmailEnabled,
      incomingEmailSecurityMode: agent.incomingEmailSecurityMode,
      incomingEmailAllowedDomain: agent.incomingEmailAllowedDomain ?? null,
      builtInAgentConfig: agent.builtInAgentConfig ?? null,
      model:
        agent.modelId && modelRows[0]
          ? { id: agent.modelId, externalId: modelRows[0].externalId }
          : null,
      llmApiKey: keyRows[0] ?? null,
      identityProviderId: agent.identityProviderId ?? null,
      environmentId: agent.environmentId ?? null,
      // Names can collide, so every sort tie-breaks on the id — a name-only
      // sort would leave equal-name rows in unspecified DB order and hash the
      // same config differently across reads.
      tools: tools.sort(byNameThen((t) => t.toolId)),
      excludedTools: excludedTools.sort(byNameThen((t) => t.toolId)),
      excludedSubagents: excludedSubagents.sort(byNameThen((s) => s.agentId)),
      // sortOrder is author-meaningful; the query's ORDER BY is kept as-is.
      suggestedPrompts,
      hooks: hooks.sort(
        // (agent_id, event, file_name) is unique — no tiebreaker needed.
        (a, b) =>
          compareStrings(a.event, b.event) ||
          compareStrings(a.fileName, b.fileName),
      ),
      knowledgeBases: knowledgeBases.sort(byNameThen((k) => k.id)),
      connectors: connectors.sort(byNameThen((c) => c.id)),
    };
  }

  /**
   * Fork a new version iff the agent's current config differs from the head
   * snapshot, bumping `agents.latest_version` in the same transaction. Call
   * AFTER all config writes of the mutation. Callers whose writes span
   * multiple transactions call this without `tx` once at the end: the fork is
   * a self-contained read-compare-insert, so at worst a crash between the
   * config commit and the fork loses one snapshot, which the next config
   * write captures.
   *
   * Locks the agent row (FOR UPDATE) so concurrent forks serialize instead of
   * racing on the `(agent_id, version)` unique index. Legacy rows
   * (`latestVersion` 0, predating versioning) fork version 1 on their first
   * config write. Returns null when the agent does not exist.
   */
  static async forkIfChanged(
    agentId: string,
    tx?: Transaction,
  ): Promise<{ version: number; forked: boolean } | null> {
    const run = async (tx: Transaction) => {
      const [agent] = await tx
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, agentId))
        .for("update");
      if (!agent) return null;

      const snapshot = await AgentVersionModel.buildConfigSnapshot(tx, agent);
      const contentHash = AgentVersionModel.computeContentHash(snapshot);

      const head =
        agent.latestVersion > 0
          ? await AgentVersionModel.findByAgentAndVersion(
              agentId,
              agent.latestVersion,
              tx,
            )
          : null;
      if (head && head.contentHash === contentHash) {
        return { version: agent.latestVersion, forked: false };
      }

      const nextVersion = agent.latestVersion + 1;
      await tx.insert(schema.agentVersionsTable).values({
        agentId,
        version: nextVersion,
        snapshot,
        contentHash,
      });
      await tx
        .update(schema.agentsTable)
        .set({ latestVersion: nextVersion })
        .where(eq(schema.agentsTable.id, agentId));
      return { version: nextVersion, forked: true };
    };

    return tx ? await run(tx) : await withDbTransaction(run);
  }

  /**
   * `forkIfChanged` that never fails the caller's write. A fork is a
   * self-contained read-compare-insert whose only job is to record history, and
   * the config change it snapshots has already committed by the time this runs,
   * so a transient fork error is logged and swallowed — the next config write
   * re-captures the missed state (same tolerance as the crash case documented on
   * `forkIfChanged`). This is the entry point every config-mutation boundary
   * uses; call `forkIfChanged` directly only when a caller must observe the fork
   * result. Intentionally takes no `tx`: it always runs in its own transaction,
   * so a swallowed error can never leave a caller's transaction aborted.
   */
  static async forkIfChangedBestEffort(
    agentId: string,
  ): Promise<{ version: number; forked: boolean } | null> {
    try {
      return await AgentVersionModel.forkIfChanged(agentId);
    } catch (error) {
      logger.error(
        { error, agentId },
        "Agent version fork failed; skipping (config change already committed)",
      );
      return null;
    }
  }

  /** Resolve a specific `(agent, version)` pair, e.g. the agent's head version. */
  static async findByAgentAndVersion(
    agentId: string,
    version: number,
    tx?: Transaction,
  ): Promise<AgentVersion | null> {
    const conn = tx ?? db;
    const [row] = await conn
      .select()
      .from(schema.agentVersionsTable)
      .where(
        and(
          eq(schema.agentVersionsTable.agentId, agentId),
          eq(schema.agentVersionsTable.version, version),
        ),
      );
    return row ?? null;
  }

  /** All versions of an agent, newest first. */
  static async listForAgent(agentId: string): Promise<AgentVersion[]> {
    return await db
      .select()
      .from(schema.agentVersionsTable)
      .where(eq(schema.agentVersionsTable.agentId, agentId))
      .orderBy(desc(schema.agentVersionsTable.version));
  }
}

export default AgentVersionModel;

// === Internal helpers ===

/**
 * Deterministic JSON for hashing: object keys sorted recursively so two
 * equivalent snapshots serialize identically regardless of key order. Arrays
 * keep their order (collections are pre-sorted by the snapshot builder;
 * suggested-prompt order is author-meaningful).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function byNameThen<T extends { name: string }>(
  id: (row: T) => string,
): (a: T, b: T) => number {
  return (a, b) =>
    compareStrings(a.name, b.name) || compareStrings(id(a), id(b));
}

/**
 * Locale-independent string order by UTF-16 code unit, matching the key sort in
 * `stableStringify`. Collection order is hashed into the snapshot, so using
 * `localeCompare` here would let the runtime's default locale reorder
 * equal-weight names and spuriously fork an otherwise-identical config.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
