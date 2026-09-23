import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
} from "@archestra/shared";
import { z } from "zod";
import {
  BatteryInstallStatusSchema,
  BatteryMatchEvidenceSchema,
} from "@/types/openappa-batteries";

/**
 * How well the policy covers one server, worst first. The first three share
 * the "not enforced" tone: rules are declared for the server and none, or not
 * all, of them are in force.
 */
export const CoveragePostureSchema = z.enum([
  /** The composition was refused: nothing declared for this server is enforced. */
  "not_enforced",
  /** Every battery aimed at the server is inactive. */
  "declared_not_enforced",
  /** Some battery aimed at the server is inactive. */
  "partly_enforced",
  /** No rule names any of its tools: the catch-all judges every call. */
  "open",
  /** Named rules, all enforced, and some tool still unlisted or no rule requires anything. */
  "guarded",
  /** Every tool named, every rule enforced, and at least one rule requires something. */
  "strict",
]);
export type CoveragePosture = z.infer<typeof CoveragePostureSchema>;

/** The posture facet: `not_enforced` stands for the three not-enforced postures. */
export const CoveragePostureFilterSchema = z.enum([
  "not_enforced",
  "open",
  "guarded",
  "strict",
]);
export type CoveragePostureFilter = z.infer<typeof CoveragePostureFilterSchema>;

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
  /** That battery's status (`refused` while the composition fails); null for a root rule. */
  batteryStatus: BatteryInstallStatusSchema.nullable(),
  /** The rule's line in the root text; null for a battery rule. */
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
  prefix: z.string(),
  /** The tool's own name, after the prefix. */
  name: z.string(),
  /** `<prefix>__<name>`, as a root rule spells it. */
  fullName: z.string(),
  kind: CoverageKindSchema,
  /** The rule this row is judged by; null when the catch-all judges it. */
  rule: CoverageRuleSchema.nullable(),
  unlisted: z.boolean(),
  enforced: z.boolean(),
  agents: z.array(CoverageAgentRefSchema),
});
export type CoverageTool = z.infer<typeof CoverageToolSchema>;

export const CoverageServerSchema = z.object({
  catalogId: z.string(),
  name: z.string(),
  /** The tool prefix its synced tools share; null while none are synced. */
  prefix: z.string().nullable(),
  toolCount: z.number().int(),
  /** Tools a rule names, enforced or not. */
  named: z.number().int(),
  enforcedCount: z.number().int(),
  notEnforcedCount: z.number().int(),
  unlisted: z.number().int(),
  posture: CoveragePostureSchema,
  /** The batteries aimed at this server, in include order. */
  batteries: z.array(
    z.object({
      name: z.string(),
      status: BatteryInstallStatusSchema,
      order: z.number().int(),
    }),
  ),
  /** The root rules that name one of its tools, in text order. */
  rootRules: z.array(z.object({ line: z.number().int(), name: z.string() })),
  agents: z.array(CoverageAgentRefSchema),
  /** Bundled batteries the catalog entry stands for and the policy does not include. */
  fits: z.array(
    z.object({ battery: z.string(), evidence: BatteryMatchEvidenceSchema }),
  ),
  /** Some unlisted tool looks like a read by its name, so its result never lowers trust. */
  readsUnlisted: z.boolean(),
});
export type CoverageServer = z.infer<typeof CoverageServerSchema>;

export const CoverageAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The servers it has explicit tool assignments on, weakest posture first. */
  servers: z.array(
    z.object({
      catalogId: z.string(),
      name: z.string(),
      posture: CoveragePostureSchema,
    }),
  ),
  weakest: CoveragePostureSchema,
});
export type CoverageAgent = z.infer<typeof CoverageAgentSchema>;

export const CoverageSummarySchema = z.object({
  servers: z.number().int(),
  tools: z.number().int(),
  /** Tools a rule names, enforced or not. */
  named: z.number().int(),
  unlisted: z.number().int(),
  agents: z.number().int(),
  /** Agents that reach a server whose posture is open or not enforced. */
  agentsReachingOpen: z.number().int(),
  rootRevision: z.number().int(),
  effectiveHash: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;

const SearchSchema = z.string().trim().max(200).optional();

export const CoverageServersQuerySchema = PaginationQuerySchema.extend({
  /** Matches the server name, its prefix or an agent that reaches it. */
  search: SearchSchema,
  posture: CoveragePostureFilterSchema.optional(),
  governedBy: z.enum(["battery", "root", "none"]).optional(),
});
export type CoverageServersQuery = z.infer<typeof CoverageServersQuerySchema>;

export const CoverageServerParamsSchema = z.object({ catalogId: z.uuid() });

export const CoverageToolsQuerySchema = PaginationQuerySchema.extend({
  /** Matches the tool name, its selector, the server name or its prefix. */
  search: SearchSchema,
  catalogId: z.uuid().optional(),
  governedBy: z.enum(["battery", "root", "catchall"]).optional(),
  kind: CoverageKindFilterSchema.optional(),
});
export type CoverageToolsQuery = z.infer<typeof CoverageToolsQuerySchema>;

export const CoverageAgentsQuerySchema = PaginationQuerySchema.extend({
  /** Matches the agent name or a server it reaches. */
  search: SearchSchema,
  weakest: CoveragePostureFilterSchema.optional(),
  /** Only agents that reach this server. */
  catalogId: z.uuid().optional(),
});
export type CoverageAgentsQuery = z.infer<typeof CoverageAgentsQuerySchema>;

export const CoverageServersPageSchema =
  createPaginatedResponseSchema(CoverageServerSchema);
export type CoverageServersPage = z.infer<typeof CoverageServersPageSchema>;
export const CoverageToolsPageSchema =
  createPaginatedResponseSchema(CoverageToolSchema);
export type CoverageToolsPage = z.infer<typeof CoverageToolsPageSchema>;
export const CoverageAgentsPageSchema =
  createPaginatedResponseSchema(CoverageAgentSchema);
export type CoverageAgentsPage = z.infer<typeof CoverageAgentsPageSchema>;
