import { SupportedProvidersSchema } from "@archestra/shared";
import { z } from "zod";

/**
 * One normalized event for every record type the Logs page shows: LLM Proxy
 * requests, MCP Gateway tool calls, Guardrails consults and yells, client
 * connection events, and audit events.
 */
export const LogSourceSchema = z.enum([
  "llm",
  "mcp",
  "guardrails",
  "connections",
  "audit",
]);
export type LogSource = z.infer<typeof LogSourceSchema>;

export const LogStatusSchema = z.enum([
  "ok",
  "error",
  "blocked",
  "pending",
  "warning",
]);
export type LogStatus = z.infer<typeof LogStatusSchema>;

const LogActorKindSchema = z.enum([
  "user",
  "agent",
  "service_account",
  "system",
]);

const GuardrailDecisionSchema = z.enum([
  "allow",
  "deny",
  "review",
  "consult",
  "yell",
]);

const ConnectionActionSchema = z.enum([
  "connected",
  "first_seen",
  "authorized",
  "token_refreshed",
  "disconnected",
]);

export const LogEventSchema = z.object({
  id: z.string(),
  source: LogSourceSchema,
  timestamp: z.string().describe("ISO 8601"),
  status: LogStatusSchema,
  title: z.string().describe("The model, the tool, the external, the action"),
  summary: z.string().optional(),
  actor: z.object({
    kind: LogActorKindSchema,
    name: z.string(),
    email: z.string().optional(),
  }),
  agent: z
    .object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["agent", "mcp_gateway", "llm_proxy"]),
    })
    .optional(),
  client: z.string().optional().describe("The client app the call came from"),
  sessionId: z.string().optional(),
  sessionTitle: z.string().optional(),
  durationMs: z.number().optional(),
  href: z.string().describe("The record's own detail page"),
  llm: z
    .object({
      provider: SupportedProvidersSchema,
      model: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadTokens: z.number(),
      cost: z.number().describe("USD at list price"),
      billingMode: z.enum(["metered", "subscription"]),
      stream: z.boolean(),
      toolCallsRequested: z.number(),
      errorCode: z.number().optional(),
    })
    .optional(),
  mcp: z
    .object({
      server: z.string(),
      tool: z.string().optional(),
      method: z.string(),
      authMethod: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
      resultPreview: z.string().optional(),
      errorMessage: z.string().optional(),
    })
    .optional(),
  guardrail: z
    .object({
      decision: GuardrailDecisionSchema,
      policy: z.string(),
      rule: z.string(),
      tool: z.string(),
      reason: z.string(),
      reviewer: z.string().optional(),
    })
    .optional(),
  connection: z
    .object({
      action: ConnectionActionSchema,
      client: z.string(),
      gateway: z.string(),
      clientVersion: z.string().optional(),
    })
    .optional(),
  audit: z
    .object({
      action: z.string(),
      category: z.string(),
      resourceType: z.string(),
      resourceName: z.string(),
      httpMethod: z.string(),
      statusCode: z.number(),
      ip: z.string(),
      diff: z
        .array(
          z.object({
            field: z.string(),
            before: z.string().nullable(),
            after: z.string().nullable(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

const FacetSchema = z.array(z.object({ value: z.string(), count: z.number() }));

/** One page of the timeline, newest first. */
export const LogEventsPageSchema = z.object({
  data: z.array(LogEventSchema),
  nextCursor: z
    .string()
    .nullable()
    .describe("Pass back as `cursor` for the next page; null on the last"),
});
export type LogEventsPage = z.infer<typeof LogEventsPageSchema>;

/**
 * Counts for the events the filters match in the window: the total, each
 * filter's values (counted as if that filter were off), and hourly buckets.
 */
export const LogStatsSchema = z.object({
  total: z.number(),
  facets: z.object({
    source: FacetSchema,
    status: FacetSchema,
    agent: FacetSchema,
    actor: FacetSchema,
    client: FacetSchema,
    model: FacetSchema,
    mcpServer: FacetSchema,
    decision: FacetSchema,
    connectionAction: FacetSchema,
    auditAction: FacetSchema,
    auditCategory: FacetSchema,
    resourceType: FacetSchema,
    resourceName: FacetSchema.describe('"resourceType::resourceName" pairs'),
    auditCategoryAction: FacetSchema.describe(
      '"auditCategory::auditAction" pairs',
    ),
    actorByKind: FacetSchema.describe('"actorKind::actorName" pairs'),
  }),
  buckets: z
    .array(
      z.object({
        start: z.string(),
        end: z.string(),
        bySource: z.record(LogSourceSchema, z.number()),
        errors: z.number(),
      }),
    )
    .describe("One bucket per hour of the window"),
  directory: z
    .object({
      agents: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(["agent", "mcp_gateway", "llm_proxy"]),
        }),
      ),
      models: z.array(
        z.object({ name: z.string(), provider: SupportedProvidersSchema }),
      ),
      emails: z.array(z.object({ name: z.string(), email: z.string() })),
    })
    .describe(
      "What the facets name: each agent's kind, model's maker, person's email",
    ),
  truncated: z
    .boolean()
    .describe(
      "A small type had more events in the window than one count reads",
    ),
});
export type LogStats = z.infer<typeof LogStatsSchema>;

const csv = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(",").filter(Boolean) : []));

export const LogStatsQuerySchema = z.object({
  sources: csv.describe("Comma-separated record types"),
  statuses: csv.describe("Comma-separated statuses"),
  decision: csv.describe("Comma-separated Guardrails decisions"),
  q: z
    .string()
    .optional()
    .describe(
      "Matches models, people, agents, clients, servers, tools, actions, resources, and an exact session id",
    ),
  sessionId: z.string().optional(),
  agent: z.string().optional().describe("An agent's name"),
  actor: z.string().optional().describe("An actor's name"),
  client: z.string().optional(),
  model: z.string().optional(),
  mcpServer: z.string().optional(),
  connectionAction: z.string().optional(),
  auditAction: z.string().optional(),
  auditCategory: z.string().optional(),
  resourceType: z.string().optional(),
  resourceName: z.string().optional(),
  actorKind: z.string().optional(),
  hours: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 7)
    .default(24)
    .describe("The window, back from now, in hours"),
});
export type LogStatsQuery = z.infer<typeof LogStatsQuerySchema>;

export const LogEventsQuerySchema = LogStatsQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional().describe("The previous page's nextCursor"),
});
export type LogEventsQuery = z.infer<typeof LogEventsQuerySchema>;
