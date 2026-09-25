import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  ResourceVisibilityScopeSchema,
} from "@archestra/shared";
import { z } from "zod";
import { SortDirectionSchema } from "@/types/api";
import {
  BatteryInstallStatusSchema,
  BatteryMatchEvidenceSchema,
} from "@/types/openappa-batteries";

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

/**
 * Tools counted by what judges them without a selector: an enforced root or
 * battery rule, a rule the runtime does not apply, or no rule, in which case
 * the policy's catch-all or, before any policy is saved, the built-in
 * fallback judges them. Every tool lands in exactly one bucket.
 */
export const CoverageRuleCountsSchema = z.object({
  root: z.number().int(),
  battery: z.number().int(),
  notEnforced: z.number().int(),
  catchAll: z.number().int(),
  builtInFallback: z.number().int(),
});
export type CoverageRuleCounts = z.infer<typeof CoverageRuleCountsSchema>;

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
  /** The same tools split by what judges them; the buckets sum to toolCount. */
  rules: CoverageRuleCountsSchema,
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
  /**
   * By name when unset. `type` puts MCP servers before gateways, `tools` is the
   * tool count, and `uncovered` the tools with no enforced rule; ties by name.
   */
  sortBy: z.enum(["name", "type", "tools", "uncovered"]).optional(),
  /** Ascending when unset, except `uncovered`, which puts the most first. */
  sortDirection: SortDirectionSchema.optional(),
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

/** The whole visible inventory in aggregate, one count per tool. */
export const CoverageSummarySchema = z.object({
  totals: CoverageRuleCountsSchema.extend({ tools: z.number().int() }),
  batteries: z.object({
    /** Included batteries whose rules are enforced, most tools first. */
    active: z.array(
      z.object({
        name: z.string(),
        /** Visible tools a rule of this battery judges. */
        tools: z.number().int(),
      }),
    ),
    /** Included batteries whose rules are not enforced, most tools first. */
    broken: z.array(
      z.object({
        name: z.string(),
        status: BatteryInstallStatusSchema.exclude(["active"]),
        /** Visible tools a rule of this battery names but does not enforce. */
        tools: z.number().int(),
      }),
    ),
    /**
     * Batteries not installed on visible servers they fit, that would give
     * some of those servers' tools with no rule one, most tools first.
     */
    available: z.array(
      z.object({
        name: z.string(),
        /** The names of the servers it fits. */
        servers: z.array(z.string()),
        /** Tools with no rule it would judge once installed. */
        tools: z.number().int(),
      }),
    ),
  }),
});
export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;

/**
 * A battery that fits a registry server and is not declared yet: how to
 * declare it, and what each of its rules would do to the server's tools.
 */
export const CoverageBatteryFitSchema = z.object({
  mcpServerId: z.string(),
  mcpServerName: z.string(),
  /** The server's tool prefixes, which `[server_aliases]` points the battery's namespaces at. */
  toolPrefixes: z.array(z.string()),
  battery: z.string(),
  description: z.string(),
  /** How the server was matched: its URL host, its container image, or its name. */
  evidence: BatteryMatchEvidenceSchema,
  /** The `include` entry that declares the battery. */
  include: z.string(),
  namespaces: z.array(z.string()),
  /** Credential variables `[credentials]` must bind to a runtime credential key before calls it routes run. */
  credentials: z.array(z.string()),
  /** The server's tools no rule names today that the battery would judge. */
  newlyCovered: z.number().int(),
  /** Every battery rule that names one of the server's tools. */
  rules: z.array(
    z.object({
      /** The full tool name, `<prefix>__<name>`. */
      tool: z.string(),
      selector: z.string().nullable(),
      kind: CoverageKindSchema.exclude(["unlisted"]),
      delta: CoverageRuleSchema.shape.delta,
      requires: CoverageRuleSchema.shape.requires,
      annotator: z.string().nullable(),
      /** What judges the tool today; null when only the catch-all does. A root rule keeps priority over the battery's. */
      currentRule: z.enum(["root", "battery"]).nullable(),
    }),
  ),
});
export type CoverageBatteryFit = z.infer<typeof CoverageBatteryFitSchema>;
