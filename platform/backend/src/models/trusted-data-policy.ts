import { CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS } from "@archestra/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { get } from "lodash-es";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { ResultPolicyCondition } from "@/database/schemas/trusted-data-policy";
import logger from "@/logging";
import type { PolicyEvaluationContext } from "@/models/tool-invocation-policy";
import type { AutonomyPolicyOperator, TrustedData } from "@/types";

/**
 * Check if a policy is a default policy (applies to all results)
 */
function isDefaultPolicy(conditions: ResultPolicyCondition[]): boolean {
  return conditions.length === 0;
}

class TrustedDataPolicyModel {
  static async create(
    policy: TrustedData.InsertTrustedDataPolicy,
  ): Promise<TrustedData.TrustedDataPolicy> {
    const [createdPolicy] = await db
      .insert(schema.trustedDataPoliciesTable)
      .values(policy)
      .returning();

    // Clear auto-configured timestamp for this tool
    await db
      .update(schema.toolsTable)
      .set({
        policiesAutoConfiguredAt: null,
        policiesAutoConfiguredReasoning: null,
      })
      .where(eq(schema.toolsTable.id, policy.toolId));

    return createdPolicy;
  }

  static async findAll(): Promise<TrustedData.TrustedDataPolicy[]> {
    return db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .orderBy(desc(schema.trustedDataPoliciesTable.createdAt));
  }

  static async findById(
    id: string,
  ): Promise<TrustedData.TrustedDataPolicy | null> {
    const [policy] = await db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id));
    return policy || null;
  }

  static async update(
    id: string,
    policy: Partial<TrustedData.InsertTrustedDataPolicy>,
  ): Promise<TrustedData.TrustedDataPolicy | null> {
    const [updatedPolicy] = await db
      .update(schema.trustedDataPoliciesTable)
      .set(policy)
      .where(eq(schema.trustedDataPoliciesTable.id, id))
      .returning();

    if (updatedPolicy) {
      // Clear auto-configured timestamp for this tool
      await db
        .update(schema.toolsTable)
        .set({
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.toolsTable.id, updatedPolicy.toolId));
    }

    return updatedPolicy || null;
  }

  static async delete(id: string): Promise<boolean> {
    // Get the policy first to access toolId
    const policy = await TrustedDataPolicyModel.findById(id);
    if (!policy) {
      return false;
    }

    const result = await db
      .delete(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.id, id))
      .returning({ id: schema.trustedDataPoliciesTable.id });

    const deleted = result.length > 0;

    if (deleted) {
      // Clear auto-configured timestamp for this tool
      await db
        .update(schema.toolsTable)
        .set({
          policiesAutoConfiguredAt: null,
          policiesAutoConfiguredReasoning: null,
        })
        .where(eq(schema.toolsTable.id, policy.toolId));
    }

    return deleted;
  }

  /**
   * Delete all trusted data policies for a specific tool.
   * Used primarily in tests.
   */
  static async deleteByToolId(toolId: string): Promise<number> {
    const result = await db
      .delete(schema.trustedDataPoliciesTable)
      .where(eq(schema.trustedDataPoliciesTable.toolId, toolId))
      .returning({ id: schema.trustedDataPoliciesTable.id });

    return result.length;
  }

  /**
   * Bulk upsert default policies (empty conditions) for multiple tools.
   * Updates existing default policies or creates new ones in a single transaction.
   */
  static async bulkUpsertDefaultPolicy(
    toolIds: string[],
    action:
      | "mark_as_trusted"
      | "mark_as_untrusted"
      | "block_always"
      | "sanitize_with_dual_llm",
  ): Promise<{ updated: number; created: number }> {
    if (toolIds.length === 0) {
      return { updated: 0, created: 0 };
    }

    // Find existing default policies (empty conditions) for these tools
    const existingPolicies = await db
      .select()
      .from(schema.trustedDataPoliciesTable)
      .where(inArray(schema.trustedDataPoliciesTable.toolId, toolIds));

    // Filter to only default policies (empty conditions array)
    const defaultPolicies = existingPolicies.filter(
      (p) => p.conditions.length === 0,
    );

    const toolIdsWithDefaultPolicy = new Set(
      defaultPolicies.map((p) => p.toolId),
    );
    const toolIdsToCreate = toolIds.filter(
      (id) => !toolIdsWithDefaultPolicy.has(id),
    );
    const policiesToUpdate = defaultPolicies.filter((p) => p.action !== action);

    let updated = 0;
    let created = 0;

    // Update existing default policies that have different action
    if (policiesToUpdate.length > 0) {
      const policyIds = policiesToUpdate.map((p) => p.id);
      await db
        .update(schema.trustedDataPoliciesTable)
        .set({ action })
        .where(inArray(schema.trustedDataPoliciesTable.id, policyIds));
      updated = policiesToUpdate.length;
    }

    // Create new default policies for tools that don't have one
    if (toolIdsToCreate.length > 0) {
      await db.insert(schema.trustedDataPoliciesTable).values(
        toolIdsToCreate.map((toolId) => ({
          toolId,
          conditions: [],
          action,
        })),
      );
      created = toolIdsToCreate.length;
    }

    return { updated, created };
  }

  /**
   * Extract values from an object using a path (supports wildcards like emails[*].from)
   */
  // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
  private static extractValuesFromPath(obj: any, path: string): any[] {
    // Handle wildcard paths like 'emails[*].from'
    if (path.includes("[*]")) {
      const parts = path.split("[*].");
      const arrayPath = parts[0];
      const itemPath = parts[1];

      const array = get(obj, arrayPath);
      if (!Array.isArray(array)) {
        return [];
      }

      return array
        .map((item) => get(item, itemPath))
        .filter((v) => v !== undefined);
    }
    // Simple path without wildcards
    const value = get(obj, path);
    return value !== undefined ? [value] : [];
  }

  /**
   * Match a context-based condition (e.g., context.teamIds, context.externalAgentId)
   */
  private static evaluateContextCondition(
    key: string,
    value: string,
    operator: AutonomyPolicyOperator.SupportedOperator,
    context: PolicyEvaluationContext,
  ): boolean {
    // Team matching - check if value is in teamIds array
    if (key === CONTEXT_TEAM_IDS) {
      switch (operator) {
        case "contains":
          return context.teamIds.includes(value);
        case "notContains":
          return !context.teamIds.includes(value);
        default:
          return false;
      }
    }

    // Single value matching for externalAgentId
    if (key === CONTEXT_EXTERNAL_AGENT_ID) {
      const contextValue = context.externalAgentId;
      switch (operator) {
        case "equal":
          return contextValue === value;
        case "notEqual":
          return contextValue !== value;
        default:
          return false;
      }
    }

    return false;
  }

  /**
   * Evaluate if a value matches a condition
   */
  private static evaluateOutputCondition(
    // biome-ignore lint/suspicious/noExplicitAny: policy values can be any type
    value: any,
    operator: AutonomyPolicyOperator.SupportedOperator,
    policyValue: string,
  ): boolean {
    switch (operator) {
      case "endsWith":
        return typeof value === "string" && value.endsWith(policyValue);
      case "startsWith":
        return typeof value === "string" && value.startsWith(policyValue);
      case "contains":
        return typeof value === "string" && value.includes(policyValue);
      case "notContains":
        return typeof value === "string" && !value.includes(policyValue);
      case "equal":
        return value === policyValue;
      case "notEqual":
        return value !== policyValue;
      case "regex":
        return typeof value === "string" && new RegExp(policyValue).test(value);
      default:
        return false;
    }
  }

  /**
   * Check if all conditions in a policy match the tool output
   */
  private static evaluateConditions(
    conditions: ResultPolicyCondition[],
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolOutput: any,
    context: PolicyEvaluationContext,
  ): boolean {
    // Empty conditions = default policy, always matches
    if (conditions.length === 0) {
      return true;
    }

    // All conditions must match (AND logic)
    for (const condition of conditions) {
      const { key, value, operator } = condition;

      // Check if this is a context condition
      if (key.startsWith("context.")) {
        if (
          !TrustedDataPolicyModel.evaluateContextCondition(
            key,
            value,
            operator,
            context,
          )
        ) {
          return false;
        }
        continue;
      }

      // Regular output-based condition
      const outputValue = toolOutput?.value || toolOutput;
      const values = TrustedDataPolicyModel.extractValuesFromPath(
        outputValue,
        key,
      );

      // If no values found for this path, condition doesn't match
      if (values.length === 0) {
        return false;
      }

      // All extracted values must match the condition
      const allMatch = values.every((v) =>
        TrustedDataPolicyModel.evaluateOutputCondition(v, operator, value),
      );

      if (!allMatch) {
        return false;
      }
    }

    return true;
  }

  /**
   * Evaluate trusted data policies for a chat
   *
   * KEY SECURITY PRINCIPLE: Data is UNTRUSTED by default.
   * - Only data that explicitly matches a trusted data policy is considered safe
   * - If no policy matches, the data is considered untrusted
   * - This implements an allowlist approach for maximum security
   * - Policies with action='block_always' take precedence and mark data as blocked
   * - Specific policies (with conditions) are evaluated before default policies (empty conditions)
   */
  static async evaluate(
    agentId: string,
    toolName: string,
    // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
    toolOutput: any,
    context: PolicyEvaluationContext,
  ): Promise<{
    isTrusted: boolean;
    isBlocked: boolean;
    shouldSanitizeWithDualLlm: boolean;
    reason: string;
  }> {
    // Use bulk evaluation for single tool
    const results = await TrustedDataPolicyModel.evaluateBulk(
      agentId,
      [{ toolName, toolOutput }],
      context,
    );
    return (
      results.get("0") || {
        isTrusted: false,
        isBlocked: false,
        shouldSanitizeWithDualLlm: false,
        reason: "Tool not found",
      }
    );
  }

  /**
   * Bulk evaluate trusted data policies for multiple tool calls
   * This method fetches all policies and tool configurations in one query to avoid N+1 issues
   */
  static async evaluateBulk(
    _agentId: string,
    toolCalls: Array<{
      toolName: string;
      // biome-ignore lint/suspicious/noExplicitAny: tool outputs can be any shape
      toolOutput: any;
    }>,
    context: PolicyEvaluationContext,
  ): Promise<
    Map<
      string,
      {
        isTrusted: boolean;
        isBlocked: boolean;
        shouldSanitizeWithDualLlm: boolean;
        reason: string;
      }
    >
  > {
    const results = new Map<
      string,
      {
        isTrusted: boolean;
        isBlocked: boolean;
        shouldSanitizeWithDualLlm: boolean;
        reason: string;
      }
    >();

    // Handle built-in MCP server tools. Policy-evaluated built-ins like
    // `query_knowledge_sources` are intentionally excluded from auto-trust:
    // they return content that can contain prompt injection, so they must be
    // treated like external tool output for trusted-data evaluation.
    for (let i = 0; i < toolCalls.length; i++) {
      const { toolName } = toolCalls[i];
      if (archestraMcpBranding.isPolicyBypassedToolName(toolName)) {
        results.set(i.toString(), {
          isTrusted: true,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: "Built-in MCP server tool",
        });
      }
    }

    // Get all tool calls subject to policy evaluation: non-built-ins plus
    // policy-evaluated built-ins like `query_knowledge_sources`.
    const nonArchestraToolCalls = toolCalls.filter(
      ({ toolName }) =>
        !archestraMcpBranding.isPolicyBypassedToolName(toolName),
    );

    if (nonArchestraToolCalls.length === 0) {
      return results;
    }

    const toolNames = nonArchestraToolCalls.map(({ toolName }) => toolName);

    // Fetch all policies and tool info in one query (tool-global, not agent-scoped)
    const allPoliciesAndTools = await db
      .select({
        toolId: schema.toolsTable.id,
        toolName: schema.toolsTable.name,
        // The backing catalog's server type is a platform fact (never
        // tool-supplied), so an owned-app launch tool cannot be forged by an
        // upstream server declaring itself one.
        serverType: schema.internalMcpCatalogTable.serverType,
        policyId: schema.trustedDataPoliciesTable.id,
        policyDescription: schema.trustedDataPoliciesTable.description,
        conditions: schema.trustedDataPoliciesTable.conditions,
        action: schema.trustedDataPoliciesTable.action,
      })
      .from(schema.toolsTable)
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.toolsTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .leftJoin(
        schema.trustedDataPoliciesTable,
        eq(schema.toolsTable.id, schema.trustedDataPoliciesTable.toolId),
      )
      .where(inArray(schema.toolsTable.name, toolNames));

    // Group policies by tool name
    const policiesByTool = new Map<
      string,
      Array<{
        policyId: string | null;
        policyDescription: string | null;
        conditions: ResultPolicyCondition[];
        action: TrustedData.TrustedDataPolicyAction | null;
      }>
    >();

    // Track tools that exist in the database
    const knownTools = new Set<string>();
    // A name resolves to an owned-app launch tool only when EVERY tool sharing
    // it is an app backing (serverType "app"). Names are unique only per catalog
    // and evaluateBulk resolves by name, so a name a non-app catalog also uses is
    // ambiguous and must not inherit app trust — otherwise a hostile server could
    // register a colliding name to skip the guardrail.
    const appNameTools = new Set<string>();
    const nonAppNameTools = new Set<string>();

    for (const row of allPoliciesAndTools) {
      knownTools.add(row.toolName);
      if (row.serverType === "app") {
        appNameTools.add(row.toolName);
      } else {
        nonAppNameTools.add(row.toolName);
      }

      if (!policiesByTool.has(row.toolName)) {
        policiesByTool.set(row.toolName, []);
      }

      policiesByTool.get(row.toolName)?.push({
        policyId: row.policyId,
        policyDescription: row.policyDescription,
        conditions: row.conditions as ResultPolicyCondition[],
        action: row.action,
      });
    }

    // Owned-app launch tools: platform-synthesized render pointers with no
    // external data — trusted only when the name is unambiguously an app backing.
    const ownedAppLaunchTools = new Set(
      [...appNameTools].filter((name) => !nonAppNameTools.has(name)),
    );

    // Process each tool call
    for (let i = 0; i < toolCalls.length; i++) {
      const { toolName, toolOutput } = toolCalls[i];

      // Skip policy-bypassing Archestra tools (already handled above);
      // policy-evaluated built-ins like `query_knowledge_sources` fall through.
      if (archestraMcpBranding.isPolicyBypassedToolName(toolName)) {
        continue;
      }

      // An owned-app launch tool ("Open <app>") returns only a platform render
      // pointer, so its result is trusted — opening an app must not flip the
      // context to sensitive and block the next call.
      if (ownedAppLaunchTools.has(toolName)) {
        results.set(i.toString(), {
          isTrusted: true,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: "Owned-app launch tool (platform-authored render pointer)",
        });
        continue;
      }

      // If tool doesn't exist in the database, treat as untrusted
      if (!knownTools.has(toolName)) {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: false,
          shouldSanitizeWithDualLlm: false,
          reason: `Tool ${toolName} not found`,
        });
        continue;
      }

      const policies = policiesByTool.get(toolName) || [];

      // Filter to actual policies (not null from LEFT JOIN)
      const actualPolicies = policies.filter((p) => p.policyId !== null);

      // Separate specific policies (with conditions) from default policies (empty conditions)
      const specificPolicies = actualPolicies.filter(
        (p) => !isDefaultPolicy(p.conditions || []),
      );
      const defaultPolicies = actualPolicies.filter((p) =>
        isDefaultPolicy(p.conditions || []),
      );
      logger.debug(
        { specificPolicies, defaultPolicies },
        "TrustedDataPolicy.evaluateBulk: specific and default policies",
      );

      // First, check specific policies for blocking
      let isBlocked = false;
      let blockReason = "";

      for (const policy of specificPolicies) {
        if (
          policy.action === "block_always" &&
          TrustedDataPolicyModel.evaluateConditions(
            policy.conditions,
            toolOutput,
            context,
          )
        ) {
          isBlocked = true;
          blockReason = `Data blocked by policy: ${policy.policyDescription || "Unnamed policy"}`;
          break;
        }
      }

      if (isBlocked) {
        results.set(i.toString(), {
          isTrusted: false,
          isBlocked: true,
          shouldSanitizeWithDualLlm: false,
          reason: blockReason,
        });
        continue;
      }

      // Check specific policies for trust/sanitize
      let matchedSpecific = false;
      for (const policy of specificPolicies) {
        if (
          TrustedDataPolicyModel.evaluateConditions(
            policy.conditions,
            toolOutput,
            context,
          )
        ) {
          matchedSpecific = true;
          if (policy.action === "mark_as_trusted") {
            results.set(i.toString(), {
              isTrusted: true,
              isBlocked: false,
              shouldSanitizeWithDualLlm: false,
              reason: `Data trusted by policy: ${policy.policyDescription || "Unnamed policy"}`,
            });
          } else if (policy.action === "mark_as_untrusted") {
            results.set(i.toString(), {
              isTrusted: false,
              isBlocked: false,
              shouldSanitizeWithDualLlm: false,
              reason: `Data untrusted by policy: ${policy.policyDescription || "Unnamed policy"}`,
            });
          } else if (policy.action === "sanitize_with_dual_llm") {
            results.set(i.toString(), {
              isTrusted: false,
              isBlocked: false,
              shouldSanitizeWithDualLlm: true,
              reason: `Data requires dual LLM sanitization by policy: ${policy.policyDescription || "Unnamed policy"}`,
            });
          }
          break;
        }
      }

      if (matchedSpecific) {
        continue;
      }

      // Fall back to default policy (empty conditions)
      const defaultPolicy = defaultPolicies[0];
      if (defaultPolicy) {
        if (defaultPolicy.action === "block_always") {
          results.set(i.toString(), {
            isTrusted: false,
            isBlocked: true,
            shouldSanitizeWithDualLlm: false,
            reason: `Data blocked by default policy: ${defaultPolicy.policyDescription || "Unnamed policy"}`,
          });
        } else if (defaultPolicy.action === "mark_as_trusted") {
          results.set(i.toString(), {
            isTrusted: true,
            isBlocked: false,
            shouldSanitizeWithDualLlm: false,
            reason: `Data trusted by default policy: ${defaultPolicy.policyDescription || "Unnamed policy"}`,
          });
        } else if (defaultPolicy.action === "mark_as_untrusted") {
          results.set(i.toString(), {
            isTrusted: false,
            isBlocked: false,
            shouldSanitizeWithDualLlm: false,
            reason: `Data untrusted by default policy: ${defaultPolicy.policyDescription || "Unnamed policy"}`,
          });
        } else if (defaultPolicy.action === "sanitize_with_dual_llm") {
          results.set(i.toString(), {
            isTrusted: false,
            isBlocked: false,
            shouldSanitizeWithDualLlm: true,
            reason: `Data requires dual LLM sanitization by default policy: ${defaultPolicy.policyDescription || "Unnamed policy"}`,
          });
        }
        continue;
      }

      // No policies match and no default - data is untrusted (restrictive mode only reaches here)
      results.set(i.toString(), {
        isTrusted: false,
        isBlocked: false,
        shouldSanitizeWithDualLlm: false,
        reason: "No matching policies - data is untrusted by default",
      });
    }

    return results;
  }

  /**
   * Default trusted-data policies (empty conditions) for tools assigned to
   * agents in the organization — audit footprint for bulk-default routes.
   */
  static async findDefaultPoliciesSnapshotForOrganization(
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await db
      .selectDistinct({
        toolId: schema.trustedDataPoliciesTable.toolId,
        action: schema.trustedDataPoliciesTable.action,
      })
      .from(schema.trustedDataPoliciesTable)
      .innerJoin(
        schema.agentToolsTable,
        eq(
          schema.agentToolsTable.toolId,
          schema.trustedDataPoliciesTable.toolId,
        ),
      )
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(
        and(
          eq(schema.agentsTable.organizationId, organizationId),
          sql`coalesce(jsonb_array_length(${schema.trustedDataPoliciesTable.conditions}), 0) = 0`,
        ),
      );

    const entries = rows
      .map((r) => `${r.toolId}:${r.action}`)
      .sort((a, b) => a.localeCompare(b));
    return { defaultTrustedDataPolicies: entries };
  }

  // Org-scoped audit snapshot via the tool → agent_tools → agents.organizationId
  // FK chain.  trustedDataPoliciesTable has no organizationId column, so
  // tenancy is resolved through any agent in the caller's organization that
  // has been assigned the policy's tool.  Mirrors the join already used by
  // `findDefaultPoliciesSnapshotForOrganization`.
  //
  // The route handler for PATCH/DELETE /api/trusted-data-policies/:id does not
  // enforce this predicate today, but the audit fetcher must — the preHandler
  // runs before route authz, so an unscoped fetch would persist another
  // tenant's policy snapshot into the caller's audit_logs even when the route
  // ultimately rejects the request.  Returns null when no agent in the
  // organization is assigned the policy's tool.
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [scoped] = await db
      .selectDistinct({
        id: schema.trustedDataPoliciesTable.id,
        toolId: schema.trustedDataPoliciesTable.toolId,
        description: schema.trustedDataPoliciesTable.description,
        conditions: schema.trustedDataPoliciesTable.conditions,
        action: schema.trustedDataPoliciesTable.action,
        createdAt: schema.trustedDataPoliciesTable.createdAt,
        updatedAt: schema.trustedDataPoliciesTable.updatedAt,
      })
      .from(schema.trustedDataPoliciesTable)
      .innerJoin(
        schema.agentToolsTable,
        eq(
          schema.agentToolsTable.toolId,
          schema.trustedDataPoliciesTable.toolId,
        ),
      )
      .innerJoin(
        schema.agentsTable,
        and(
          eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(
        and(
          eq(schema.trustedDataPoliciesTable.id, id),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!scoped) return null;

    return {
      id: scoped.id,
      toolId: scoped.toolId,
      description: scoped.description ?? null,
      conditions: scoped.conditions,
      action: scoped.action,
      createdAt: scoped.createdAt.toISOString(),
      updatedAt: scoped.updatedAt.toISOString(),
    };
  }
}

export default TrustedDataPolicyModel;
