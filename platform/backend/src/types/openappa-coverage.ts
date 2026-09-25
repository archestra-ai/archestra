import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  ResourceVisibilityScopeSchema,
} from "@archestra/shared";
import { z } from "zod";
import { BatteryInstallStatusSchema } from "@/types/openappa-batteries";

/**
 * What kind of rule governs a tool, from its delta and requirements: a rule
 * that requires an attention mark is `approval`, one that requires anything
 * else is `write`, one that only narrows the labels (or defers to an
 * annotator) is `read`, one that does neither is `neutral`. A tool no rule
 * names is `unlisted`.
 */
export const CoverageKindSchema = z.enum([
  "read",
  "write",
  "approval",
  "neutral",
  "unlisted",
]);
export type CoverageKind = z.infer<typeof CoverageKindSchema>;

/** The kind facet: `write` includes the rules that also need approval. */
export const CoverageKindFilterSchema = z.enum(["read", "write", "approval"]);
export type CoverageKindFilter = z.infer<typeof CoverageKindFilterSchema>;

const CoverageAgentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** One `[[policy.tool]]` entry as the coverage parse read it. */
export const CoverageRuleSchema = z.object({
  source: z.enum(["root", "battery"]),
  /** The battery that declares the rule; null for a root rule. */
  battery: z.string().nullable(),
  /** The exact include entry that supplies a battery rule; null for a root rule. */
  batteryEntry: z.string().nullable(),
  /** That battery's status (`refused` while the composition fails); null for a root rule. */
  batteryStatus: BatteryInstallStatusSchema.nullable(),
  /** The rule's header line in its source TOML, when it can be located. */
  line: z.number().int().nullable(),
  /** The tool name as the rule spells it, without its selector. */
  name: z.string(),
  /** The argument selector between the parentheses, or null. */
  selector: z.string().nullable(),
  /** How the result narrows the session's labels. An object form's `contains` list is flattened. */
  delta: z.object({
    trust: z.string().optional(),
    audience: z.array(z.string()).optional(),
  }),
  /** What a call needs before it runs. An object form's `contains` list is flattened. */
  requires: z.object({
    trust: z.string().optional(),
    audience: z.array(z.string()).optional(),
    attention: z.array(z.string()).optional(),
  }),
  annotator: z.string().nullable(),
  /** Whether the runtime judges calls by this rule: the composition succeeded and, for a battery rule, the battery is active. */
  enforced: z.boolean(),
});
export type CoverageRule = z.infer<typeof CoverageRuleSchema>;

/**
 * One row of the tools table. A tool is one row judged by its first matching
 * rule without a selector (or by the catch-all when none matches), plus one
 * row per selector rule that names it, so a root override sits beside the
 * battery rule it overrides.
 */
export const CoverageToolSchema = z.object({
  toolId: z.string(),
  catalogId: z.string(),
  catalogName: z.string(),
  catalogIcon: z.string().nullable(),
  prefix: z.string(),
  /** The tool's own name, after the prefix. */
  name: z.string(),
  /** `<prefix>__<name>`, as a root rule spells it. */
  fullName: z.string(),
  /** The MCP `readOnlyHint` annotation; null when the server gave none. */
  readOnly: z.boolean().nullable(),
  kind: CoverageKindSchema,
  /** Built-in default fallback, user fallback, root rule, or battery rule. */
  policySource: z.enum(["built_in", "fallback", "root", "battery"]),
  /** The rule this row is judged by; null when the catch-all judges it. */
  rule: CoverageRuleSchema.nullable(),
  /** The root catch-all header line, when an unlisted tool uses one. */
  fallbackLine: z.number().int().nullable(),
  unlisted: z.boolean(),
  enforced: z.boolean(),
  agents: z.array(CoverageAgentRefSchema),
});
export type CoverageTool = z.infer<typeof CoverageToolSchema>;

/** A visible agent, MCP gateway, or MCP registry server with tool coverage. */
export const CoverageEntitySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(["agent", "mcp_gateway", "mcp_server"]),
  scope: ResourceVisibilityScopeSchema,
  icon: z.string().nullable(),
  /** Assigned tools plus Auto-mode tools discoverable by this viewer. */
  toolCount: z.number().int(),
  /** Tools with at least one active root or battery rule, including selector rules. */
  governedCount: z.number().int(),
  /** Tools with no unconditional rule, so some calls may use the catch-all. */
  fallbackCount: z.number().int(),
  /** Assigned Archestra built-in tools, included in toolCount. */
  builtInCount: z.number().int(),
  /** Counts for this entity include the current viewer's dynamic access. */
  autoMode: z.boolean(),
});
export type CoverageEntity = z.infer<typeof CoverageEntitySchema>;

const SearchSchema = z.string().trim().max(200).optional();

export const CoverageToolsQuerySchema = PaginationQuerySchema.extend({
  /** Matches the tool name, its selector, the server name or its prefix. */
  search: SearchSchema,
  catalogId: z.uuid().optional(),
  /** Tools reachable through this agent or MCP gateway, including Auto mode discovery. */
  entityId: z.uuid().optional(),
  governedBy: z.enum(["battery", "root", "catchall", "built_in"]).optional(),
  /** Narrow battery rules to one included battery. */
  battery: z.string().trim().min(1).max(100).optional(),
  kind: CoverageKindFilterSchema.optional(),
});
export type CoverageToolsQuery = z.infer<typeof CoverageToolsQuerySchema>;

export const CoverageEntitiesQuerySchema = PaginationQuerySchema.extend({
  search: SearchSchema,
  /** Agents are never listed, so `agent` matches nothing. */
  type: CoverageEntitySchema.shape.type.optional(),
  /** Resolve one visible target by its stable row ID. */
  entityId: z.uuid().optional(),
  /** Only the targets that reach this tool: the agents and gateways that can call it, and its server. */
  toolId: z.uuid().optional(),
});
export type CoverageEntitiesQuery = z.infer<typeof CoverageEntitiesQuerySchema>;

export const CoverageToolsPageSchema = createPaginatedResponseSchema(
  CoverageToolSchema,
).extend({
  /** Servers with tools available through the selected agent or gateway. */
  servers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      icon: z.string().nullable(),
    }),
  ),
  /** Batteries represented by the selected target, before source filtering. */
  batteries: z.array(z.string()),
});
export type CoverageToolsPage = z.infer<typeof CoverageToolsPageSchema>;
export const CoverageEntitiesPageSchema =
  createPaginatedResponseSchema(CoverageEntitySchema);
export type CoverageEntitiesPage = z.infer<typeof CoverageEntitiesPageSchema>;
