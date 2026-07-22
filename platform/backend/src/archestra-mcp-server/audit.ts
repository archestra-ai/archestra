import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import logger from "@/logging";
import { sanitizeAuditSnapshot } from "@/middleware/audit-log-hook";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import AppModel from "@/models/app";
import AuditLogModel from "@/models/audit-log";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import KnowledgeBaseModel from "@/models/knowledge-base";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import LimitModel from "@/models/limit";
import McpServerModel from "@/models/mcp-server";
import SkillModel from "@/models/skill";
import TeamModel from "@/models/team";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import TrustedDataPolicyModel from "@/models/trusted-data-policy";
import UserModel from "@/models/user";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import { parseSkillManifest, SkillParseError } from "@/skills/parser";
import type { AuditEventName } from "@/types/audit-log";

// === Public surface

type ArchestraToolAuditContext = {
  organizationId: string;
  userId: string;
};

/**
 * How to audit one mutating Archestra MCP tool. Mirrors the HTTP registry
 * (`AUDITABLE_ROUTES`): same event vocabulary, same per-model snapshot
 * fetchers, so a mutation reads identically in the audit log whether it
 * arrived over `/api/*` or through the MCP surface.
 */
type ArchestraToolAuditSpec = {
  resourceType: string;
  action: AuditEventName;
  /** Pick the target id straight from validated tool args (edits/deletes). */
  idFromArgs?: (args: Record<string, unknown>) => string | null;
  /** Pick the created id from the tool's structuredContent on success. */
  idFromResult?: (
    structured: Record<string, unknown> | undefined,
  ) => string | null;
  /** Pre-invoke lookup for name-addressed targets (skills). */
  lookupIdBefore?: (
    args: Record<string, unknown>,
    ctx: ArchestraToolAuditContext,
  ) => Promise<string | null>;
  /** Post-invoke lookup for creates whose results carry no structured id. */
  lookupIdAfter?: (
    args: Record<string, unknown>,
    ctx: ArchestraToolAuditContext,
  ) => Promise<string | null>;
  /**
   * The org itself is the audited resource (bulk operations) — mirrors the
   * HTTP registry's `resourceIdSource: "organizationContext"`.
   */
  useOrganizationAsResource?: boolean;
  fetchById?: (
    id: string,
    organizationId: string,
  ) => Promise<Record<string, unknown> | null>;
};

/** Resolved pre-invoke state the dispatch threads through to the writer. */
type ArchestraToolAuditCapture = {
  spec: ArchestraToolAuditSpec;
  ctx: ArchestraToolAuditContext;
  targetId: string | null;
  before: Record<string, unknown> | null;
  occurredAt: Date;
};

/**
 * Spec for a tool by its full (`archestra__x`) or short name; undefined for
 * read-only tools and for mutations whose HTTP twins are deliberately
 * unaudited (hooks, projects, app data store, sandbox files) — parity with
 * `AUDIT_DECISIONS` is the contract.
 */
function getToolAuditSpec(
  toolName: string,
): ArchestraToolAuditSpec | undefined {
  return TOOL_AUDIT_SPECS[toolName.replace(/^archestra__/, "")];
}

/**
 * Resolve the audited target id and `before` snapshot ahead of the tool's
 * execution. Returns null when the tool isn't audited or the context lacks an
 * authenticated user (app-proxy calls without a user session are skipped).
 */
export async function captureToolAuditBefore(params: {
  toolName: string;
  args: Record<string, unknown>;
  organizationId: string | undefined;
  userId: string | undefined;
}): Promise<ArchestraToolAuditCapture | null> {
  const spec = getToolAuditSpec(params.toolName);
  if (!spec || !params.organizationId || !params.userId) return null;

  const ctx: ArchestraToolAuditContext = {
    organizationId: params.organizationId,
    userId: params.userId,
  };
  const capture: ArchestraToolAuditCapture = {
    spec,
    ctx,
    targetId: null,
    before: null,
    occurredAt: new Date(),
  };

  try {
    capture.targetId = spec.useOrganizationAsResource
      ? ctx.organizationId
      : (spec.idFromArgs?.(params.args) ??
        (await spec.lookupIdBefore?.(params.args, ctx)) ??
        null);
    // Creates have no prior state; everything else snapshots it when the
    // target resolved.
    if (
      capture.targetId &&
      spec.fetchById &&
      !spec.action.endsWith(".created")
    ) {
      capture.before = sanitizeAuditSnapshot(
        await spec.fetchById(capture.targetId, ctx.organizationId),
      );
    }
  } catch (err) {
    logger.error(
      { err, toolName: params.toolName },
      "audit: mcp before-state failed",
    );
  }
  return capture;
}

/**
 * Write the audit row for an executed mutating tool. Fire-and-forget from the
 * dispatch (`void recordToolAudit(...)`): audit persistence must never fail or
 * slow a tool call, mirroring the HTTP onResponse hook.
 */
export async function recordToolAudit(params: {
  capture: ArchestraToolAuditCapture;
  toolName: string;
  args: Record<string, unknown>;
  result: CallToolResult;
}): Promise<void> {
  const { capture, toolName, args, result } = params;
  const { spec, ctx } = capture;
  try {
    const outcome = result.isError ? "failure" : "success";

    let resourceId = capture.targetId;
    if (!resourceId && outcome === "success") {
      resourceId =
        spec.idFromResult?.(
          result.structuredContent as Record<string, unknown> | undefined,
        ) ??
        (await spec.lookupIdAfter?.(args, ctx)) ??
        null;
    }

    const after =
      outcome === "success" &&
      !spec.action.endsWith(".deleted") &&
      resourceId &&
      spec.fetchById
        ? sanitizeAuditSnapshot(
            await spec.fetchById(resourceId, ctx.organizationId),
          )
        : null;

    const actor = await UserModel.getById(ctx.userId);
    await AuditLogModel.create({
      organizationId: ctx.organizationId,
      actorId: ctx.userId,
      actorType: "user",
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      action: spec.action,
      outcome,
      resourceType: spec.resourceType,
      resourceId,
      before: capture.before,
      after,
      httpMethod: null,
      // Not an HTTP path, but the column is the log's searchable "where" —
      // record the tool surface so admins can tell MCP-originated rows apart
      // and filter on the tool name.
      httpPath: `mcp-tool:${toolName}`,
      httpRoute: null,
      httpStatus: null,
      requestId: null,
      sourceIp: null,
      userAgent: null,
      occurredAt: capture.occurredAt,
    });
  } catch (err) {
    logger.error(
      { err, toolName },
      "audit: failed to write MCP tool audit row",
    );
    reportAuditWriteFailure({
      source: "mcp_tool",
      resourceType: spec.resourceType,
    });
  }
}

// === Internal: per-tool spec registry

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Resolve a skill by the name tools address it with. Only an unambiguous
 * match is used — with duplicate names across scopes the row still records
 * the action and actor, just without a snapshot.
 */
async function skillIdByName(
  name: unknown,
  ctx: ArchestraToolAuditContext,
): Promise<string | null> {
  if (typeof name !== "string" || !name) return null;
  const candidates = await SkillModel.findAllByName(ctx.organizationId, name);
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * After create_skill succeeds, find the created row: the skill named in the
 * manifest, authored by the caller (create_skill always creates a personal
 * skill owned by the calling user).
 */
async function createdSkillId(
  args: Record<string, unknown>,
  ctx: ArchestraToolAuditContext,
): Promise<string | null> {
  if (typeof args.content !== "string") return null;
  let name: string;
  try {
    name = parseSkillManifest(args.content).name;
  } catch (error) {
    if (error instanceof SkillParseError) return null;
    throw error;
  }
  const candidates = await SkillModel.findAllByName(ctx.organizationId, name);
  const own = candidates.filter((s) => s.authorId === ctx.userId);
  if (own.length === 0) return null;
  return own.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).id;
}

const agentFetch = (id: string, orgId: string) =>
  AgentModel.findByIdForAudit(id, orgId);
const teamFetch = (id: string, orgId: string) =>
  TeamModel.findByIdForAudit(id, orgId);
const skillFetch = (id: string, orgId: string) =>
  SkillModel.findByIdForAudit(id, orgId);
const appFetch = (id: string, orgId: string) =>
  AppModel.findByIdForAudit(id, orgId);
const catalogFetch = (id: string, orgId: string) =>
  InternalMcpCatalogModel.findByIdForAudit(id, orgId);
const connectorFetch = (id: string, orgId: string) =>
  KnowledgeBaseConnectorModel.findByIdForAudit(id, orgId);
const assignmentCountFetch = (id: string, _orgId: string) =>
  AgentToolModel.countAssignmentsForOrganization(id);

/**
 * agent-resources' create handlers return plain text (no structured id), and
 * agent names are not unique — creates record actor + action with a null
 * resource id rather than guessing.
 */
const agentCreateSpec: ArchestraToolAuditSpec = {
  resourceType: "agent",
  action: "agent.created",
  fetchById: agentFetch,
};
const agentEditSpec: ArchestraToolAuditSpec = {
  resourceType: "agent",
  action: "agent.updated",
  idFromArgs: (a) => str(a.id),
  fetchById: agentFetch,
};

const TOOL_AUDIT_SPECS: Record<string, ArchestraToolAuditSpec> = {
  // Agents / LLM proxies / MCP gateways (all rows in the agents table).
  create_agent: agentCreateSpec,
  create_llm_proxy: agentCreateSpec,
  create_mcp_gateway: agentCreateSpec,
  edit_agent: agentEditSpec,
  edit_llm_proxy: agentEditSpec,
  edit_mcp_gateway: agentEditSpec,

  // Teams (incl. membership and external-group mutations — team.updated with
  // the members/externalGroups diff, same as the HTTP child routes).
  create_team: {
    resourceType: "team",
    action: "team.created",
    idFromResult: (s) =>
      str((s?.team as Record<string, unknown> | undefined)?.id),
    fetchById: teamFetch,
  },
  edit_team: {
    resourceType: "team",
    action: "team.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: teamFetch,
  },
  delete_team: {
    resourceType: "team",
    action: "team.deleted",
    idFromArgs: (a) => str(a.id),
    fetchById: teamFetch,
  },
  add_team_member: {
    resourceType: "team",
    action: "team.updated",
    idFromArgs: (a) => str(a.team_id),
    fetchById: teamFetch,
  },
  update_team_member_role: {
    resourceType: "team",
    action: "team.updated",
    idFromArgs: (a) => str(a.team_id),
    fetchById: teamFetch,
  },
  remove_team_member: {
    resourceType: "team",
    action: "team.updated",
    idFromArgs: (a) => str(a.team_id),
    fetchById: teamFetch,
  },
  add_team_external_group: {
    resourceType: "team",
    action: "team.updated",
    idFromArgs: (a) => str(a.team_id),
    fetchById: teamFetch,
  },
  remove_team_external_group: {
    resourceType: "team",
    action: "team.updated",
    idFromArgs: (a) => str(a.team_id),
    fetchById: teamFetch,
  },

  // Skills (name-addressed; snapshots include content + file fingerprints).
  create_skill: {
    resourceType: "skill",
    action: "skill.created",
    lookupIdAfter: createdSkillId,
    fetchById: skillFetch,
  },
  update_skill: {
    resourceType: "skill",
    action: "skill.updated",
    lookupIdBefore: (a, ctx) => skillIdByName(a.name, ctx),
    fetchById: skillFetch,
  },
  edit_skill: {
    resourceType: "skill",
    action: "skill.updated",
    lookupIdBefore: (a, ctx) => skillIdByName(a.name, ctx),
    fetchById: skillFetch,
  },

  // Autonomy policies.
  create_tool_invocation_policy: {
    resourceType: "toolInvocationPolicy",
    action: "toolInvocationPolicy.created",
    idFromResult: (s) =>
      str((s?.policy as Record<string, unknown> | undefined)?.id),
    fetchById: (id, orgId) =>
      ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },
  update_tool_invocation_policy: {
    resourceType: "toolInvocationPolicy",
    action: "toolInvocationPolicy.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) =>
      ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },
  delete_tool_invocation_policy: {
    resourceType: "toolInvocationPolicy",
    action: "toolInvocationPolicy.deleted",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) =>
      ToolInvocationPolicyModel.findByIdForAudit(id, orgId),
  },
  create_trusted_data_policy: {
    resourceType: "trustedDataPolicy",
    action: "trustedDataPolicy.created",
    idFromResult: (s) =>
      str((s?.policy as Record<string, unknown> | undefined)?.id),
    fetchById: (id, orgId) =>
      TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },
  update_trusted_data_policy: {
    resourceType: "trustedDataPolicy",
    action: "trustedDataPolicy.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) =>
      TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },
  delete_trusted_data_policy: {
    resourceType: "trustedDataPolicy",
    action: "trustedDataPolicy.deleted",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) =>
      TrustedDataPolicyModel.findByIdForAudit(id, orgId),
  },

  // Limits.
  create_limit: {
    resourceType: "limit",
    action: "limit.created",
    idFromResult: (s) =>
      str((s?.limit as Record<string, unknown> | undefined)?.id),
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  update_limit: {
    resourceType: "limit",
    action: "limit.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },
  delete_limit: {
    resourceType: "limit",
    action: "limit.deleted",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) => LimitModel.findByIdForAudit(id, orgId),
  },

  // Apps.
  scaffold_app: {
    resourceType: "app",
    action: "app.created",
    idFromResult: (s) => str(s?.id),
    fetchById: appFetch,
  },
  edit_app: {
    resourceType: "app",
    action: "app.updated",
    idFromArgs: (a) => str(a.appId),
    fetchById: appFetch,
  },
  refine_app: {
    resourceType: "app",
    action: "app.updated",
    idFromArgs: (a) => str(a.appId),
    fetchById: appFetch,
  },
  set_app_tools: {
    resourceType: "app",
    action: "app.updated",
    idFromArgs: (a) => str(a.appId),
    fetchById: appFetch,
  },
  publish_app: {
    resourceType: "app",
    action: "app.updated",
    idFromArgs: (a) => str(a.appId),
    fetchById: appFetch,
  },
  delete_app: {
    resourceType: "app",
    action: "app.deleted",
    idFromArgs: (a) => str(a.appId),
    fetchById: appFetch,
  },

  // Internal MCP catalog + deployments.
  create_mcp_server: {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.created",
    idFromResult: (s) => str(s?.id),
    fetchById: catalogFetch,
  },
  edit_mcp_description: {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: catalogFetch,
  },
  edit_mcp_config: {
    resourceType: "internalMcpCatalog",
    action: "internalMcpCatalog.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: catalogFetch,
  },
  deploy_mcp_server: {
    resourceType: "mcpServer",
    action: "mcpServer.created",
    idFromResult: (s) => str(s?.id ?? s?.serverId),
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },
  reload_mcp_server_tools: {
    resourceType: "mcpServer",
    action: "mcpServer.updated",
    idFromArgs: (a) => str(a.serverId),
    fetchById: (id, orgId) => McpServerModel.findByIdForAudit(id, orgId),
  },

  // Bulk tool assignment — the org is the resource, same as the HTTP
  // /api/agents/tools/bulk-assign registration.
  bulk_assign_tools_to_agents: {
    resourceType: "agentTool",
    action: "agentTool.bulk_assigned",
    useOrganizationAsResource: true,
    fetchById: assignmentCountFetch,
  },
  bulk_assign_tools_to_mcp_gateways: {
    resourceType: "agentTool",
    action: "agentTool.bulk_assigned",
    useOrganizationAsResource: true,
    fetchById: assignmentCountFetch,
  },
  bulk_remove_tools_from_agents: {
    resourceType: "agentTool",
    action: "agentTool.bulk_removed",
    useOrganizationAsResource: true,
    fetchById: assignmentCountFetch,
  },

  // Knowledge bases and connectors.
  create_knowledge_base: {
    resourceType: "knowledgeBase",
    action: "knowledgeBase.created",
    idFromResult: (s) =>
      str((s?.knowledgeBase as Record<string, unknown> | undefined)?.id),
    fetchById: (id, orgId) => KnowledgeBaseModel.findByIdForAudit(id, orgId),
  },
  update_knowledge_base: {
    resourceType: "knowledgeBase",
    action: "knowledgeBase.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) => KnowledgeBaseModel.findByIdForAudit(id, orgId),
  },
  delete_knowledge_base: {
    resourceType: "knowledgeBase",
    action: "knowledgeBase.deleted",
    idFromArgs: (a) => str(a.id),
    fetchById: (id, orgId) => KnowledgeBaseModel.findByIdForAudit(id, orgId),
  },
  create_knowledge_connector: {
    resourceType: "connector",
    action: "connector.created",
    idFromResult: (s) =>
      str((s?.knowledgeConnector as Record<string, unknown> | undefined)?.id),
    fetchById: connectorFetch,
  },
  update_knowledge_connector: {
    resourceType: "connector",
    action: "connector.updated",
    idFromArgs: (a) => str(a.id),
    fetchById: connectorFetch,
  },
  delete_knowledge_connector: {
    resourceType: "connector",
    action: "connector.deleted",
    idFromArgs: (a) => str(a.id),
    fetchById: connectorFetch,
  },
  assign_knowledge_connector_to_knowledge_base: {
    resourceType: "connector",
    action: "connector.updated",
    idFromArgs: (a) => str(a.connector_id),
    fetchById: connectorFetch,
  },
  unassign_knowledge_connector_from_knowledge_base: {
    resourceType: "connector",
    action: "connector.updated",
    idFromArgs: (a) => str(a.connector_id),
    fetchById: connectorFetch,
  },
  assign_knowledge_base_to_agent: {
    resourceType: "agent",
    action: "agent.updated",
    idFromArgs: (a) => str(a.agent_id),
    fetchById: agentFetch,
  },
  unassign_knowledge_base_from_agent: {
    resourceType: "agent",
    action: "agent.updated",
    idFromArgs: (a) => str(a.agent_id),
    fetchById: agentFetch,
  },
  assign_knowledge_connector_to_agent: {
    resourceType: "agent",
    action: "agent.updated",
    idFromArgs: (a) => str(a.agent_id),
    fetchById: agentFetch,
  },
  unassign_knowledge_connector_from_agent: {
    resourceType: "agent",
    action: "agent.updated",
    idFromArgs: (a) => str(a.agent_id),
    fetchById: agentFetch,
  },
};
