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

export const LogEventsResponseSchema = z.object({
  data: z.array(LogEventSchema),
  nextCursor: z.string().nullable(),
  total: z.number().describe("Matching events in the window that was read"),
  /**
   * Each type is read up to a fixed number of its newest events in the window,
   * so a busy window's counts cover those, not every event in it.
   */
  truncated: z.boolean(),
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
    .describe("48 equal buckets over the window"),
});
export type LogEventsResponse = z.infer<typeof LogEventsResponseSchema>;

const csv = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(",").filter(Boolean) : []));

export const LogEventsQuerySchema = z.object({
  sources: csv.describe("Comma-separated record types"),
  statuses: csv.describe("Comma-separated statuses"),
  decision: csv.describe("Comma-separated Guardrails decisions"),
  q: z.string().optional().describe("Free text over every shown field"),
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
    .positive()
    .max(24 * 90)
    .default(24)
    .describe("The window, back from now, in hours"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional().describe("The previous page's nextCursor"),
});
export type LogEventsQuery = z.infer<typeof LogEventsQuerySchema>;
