import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const A2aDiscoveryModeSchema = z.enum([
  "well_known",
  "card_url",
  "inline_card",
]);

export const A2aConnectionAuthTypeSchema = z.enum([
  "none",
  "bearer",
  "api_key",
]);

export const A2aSelectedInterfaceSchema = z.object({
  url: z.string().url(),
  protocolBinding: z.enum(["JSONRPC", "HTTP+JSON"]),
  protocolVersion: z.string().min(1),
  tenant: z.string().optional(),
});

export const A2aSecurityRequirementSchema = z.record(
  z.string(),
  z.array(z.string()),
);

export const A2aConnectionAuthConfigSchema = z.object({
  headerName: z.string().min(1).optional(),
});

export const A2aOutboundRunStateSchema = z.enum([
  "pending",
  "submitted",
  "working",
  "completed",
  "failed",
  "canceled",
  "input_required",
  "auth_required",
  "rejected",
  "unknown",
]);

export const A2aAgentCardJsonSchema = z.record(z.string(), z.unknown());

export const A2aRemoteAgentSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("well_known"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("card_url"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("inline_card"),
    agentCard: A2aAgentCardJsonSchema,
  }),
]);

const FORBIDDEN_A2A_AUTH_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const A2aApiKeyHeaderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "API-key header name is invalid")
  .refine(
    (name) => !FORBIDDEN_A2A_AUTH_HEADERS.has(name.toLowerCase()),
    "API-key header name is reserved and cannot carry credentials",
  );

const A2aConnectionAuthSelectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer") }),
  z.object({
    type: z.literal("api_key"),
    headerName: A2aApiKeyHeaderNameSchema,
  }),
]);

export const A2aConnectionAuthInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("bearer"),
    credential: z.string().trim().min(1).max(20_000),
  }),
  z.object({
    type: z.literal("api_key"),
    headerName: A2aApiKeyHeaderNameSchema,
    credential: z.string().trim().min(1).max(20_000),
  }),
]);

export const InspectA2aRemoteAgentRequestSchema = z.object({
  source: A2aRemoteAgentSourceSchema,
  auth: A2aConnectionAuthSelectionSchema.optional(),
});

export const CreateA2aRemoteAgentRequestSchema = z.object({
  source: A2aRemoteAgentSourceSchema,
  auth: A2aConnectionAuthInputSchema.default({ type: "none" }),
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  connectionName: z.string().trim().min(1).max(255).default("Default"),
  scope: ResourceVisibilityScopeSchema.default("personal"),
  teams: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
});

export const UpdateA2aRemoteAgentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    source: A2aRemoteAgentSourceSchema.optional(),
    auth: A2aConnectionAuthInputSchema.optional(),
    enabled: z.boolean().optional(),
    connectionName: z.string().trim().min(1).max(255).optional(),
    scope: ResourceVisibilityScopeSchema.optional(),
    teams: z.array(z.string()).optional(),
    users: z.array(z.string()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

export type A2aDiscoveryMode = z.infer<typeof A2aDiscoveryModeSchema>;
export type A2aConnectionAuthType = z.infer<typeof A2aConnectionAuthTypeSchema>;
export type A2aSelectedInterface = z.infer<typeof A2aSelectedInterfaceSchema>;
export type A2aSecurityRequirement = z.infer<
  typeof A2aSecurityRequirementSchema
>;
export type A2aConnectionAuthConfig = z.infer<
  typeof A2aConnectionAuthConfigSchema
>;
export type A2aOutboundRunState = z.infer<typeof A2aOutboundRunStateSchema>;

export const SelectA2aRemoteAgentSchema = createSelectSchema(
  schema.a2aRemoteAgentsTable,
  {
    discoveryMode: A2aDiscoveryModeSchema,
    agentCard: A2aAgentCardJsonSchema,
    scope: ResourceVisibilityScopeSchema,
  },
);
export const InsertA2aRemoteAgentSchema = createInsertSchema(
  schema.a2aRemoteAgentsTable,
  {
    discoveryMode: A2aDiscoveryModeSchema,
    agentCard: A2aAgentCardJsonSchema,
    scope: ResourceVisibilityScopeSchema,
  },
);
export const SelectA2aConnectionSchema = createSelectSchema(
  schema.a2aConnectionsTable,
  {
    selectedInterface: A2aSelectedInterfaceSchema,
    securityRequirement: A2aSecurityRequirementSchema.nullable(),
    authType: A2aConnectionAuthTypeSchema,
    authConfig: A2aConnectionAuthConfigSchema,
  },
);
export const InsertA2aConnectionSchema = createInsertSchema(
  schema.a2aConnectionsTable,
  {
    selectedInterface: A2aSelectedInterfaceSchema,
    securityRequirement: A2aSecurityRequirementSchema.nullable().optional(),
    authType: A2aConnectionAuthTypeSchema,
    authConfig: A2aConnectionAuthConfigSchema.optional(),
  },
);
export const SelectA2aOutboundRunSchema = createSelectSchema(
  schema.a2aOutboundRunsTable,
  {
    state: A2aOutboundRunStateSchema,
    interfaceSnapshot: A2aSelectedInterfaceSchema,
  },
);
export const InsertA2aOutboundRunSchema = createInsertSchema(
  schema.a2aOutboundRunsTable,
  {
    state: A2aOutboundRunStateSchema,
    interfaceSnapshot: A2aSelectedInterfaceSchema,
  },
);

export type A2aRemoteAgent = z.infer<typeof SelectA2aRemoteAgentSchema>;
export type InsertA2aRemoteAgent = z.infer<typeof InsertA2aRemoteAgentSchema>;
export type A2aConnection = z.infer<typeof SelectA2aConnectionSchema>;
export type InsertA2aConnection = z.infer<typeof InsertA2aConnectionSchema>;
export type A2aOutboundRun = z.infer<typeof SelectA2aOutboundRunSchema>;
export type InsertA2aOutboundRun = z.infer<typeof InsertA2aOutboundRunSchema>;

export const PublicA2aConnectionSchema = SelectA2aConnectionSchema.omit({
  secretId: true,
}).extend({
  hasCredential: z.boolean(),
});

export const PublicA2aRemoteAgentSchema = SelectA2aRemoteAgentSchema.extend({
  connection: PublicA2aConnectionSchema,
  toolId: z.string().uuid(),
  authorName: z.string().nullable(),
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  users: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string() }),
  ),
});

export const ListA2aRemoteAgentsQuerySchema = z.object({
  scope: ResourceVisibilityScopeSchema.optional(),
  teamId: z.string().optional(),
  authorId: z.string().optional(),
  accessibleOnly: z.stringbool().meta({ type: "boolean" }).optional(),
});

export const A2aRemoteAgentInspectionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  agentCard: A2aAgentCardJsonSchema,
  cardHash: z.string(),
  selectedInterface: A2aSelectedInterfaceSchema,
  supportedAuthTypes: z.array(A2aConnectionAuthTypeSchema),
  selectedSecurityRequirement: A2aSecurityRequirementSchema.nullable(),
});

export const A2aDelegationTargetSchema = z.object({
  remoteAgentId: z.string().uuid(),
  connectionId: z.string().uuid(),
  toolId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
});

export const SyncA2aDelegationsRequestSchema = z.object({
  connectionIds: z.array(z.string().uuid()).max(500),
});

export const SyncA2aDelegationsResponseSchema = z.object({
  added: z.array(z.string().uuid()),
  removed: z.array(z.string().uuid()),
});

export const A2aOutboundRunSummarySchema = SelectA2aOutboundRunSchema.pick({
  id: true,
  parentAgentId: true,
  connectionId: true,
  toolId: true,
  userId: true,
  conversationId: true,
  toolCallId: true,
  messageId: true,
  remoteTaskId: true,
  remoteContextId: true,
  state: true,
  targetNameSnapshot: true,
  interfaceSnapshot: true,
  errorCode: true,
  statusReason: true,
  startedAt: true,
  completedAt: true,
});

export type A2aRemoteAgentSource = z.infer<typeof A2aRemoteAgentSourceSchema>;
export type A2aConnectionAuthInput = z.infer<
  typeof A2aConnectionAuthInputSchema
>;
export type InspectA2aRemoteAgentRequest = z.infer<
  typeof InspectA2aRemoteAgentRequestSchema
>;
export type CreateA2aRemoteAgentRequest = z.input<
  typeof CreateA2aRemoteAgentRequestSchema
>;
export type UpdateA2aRemoteAgentRequest = z.infer<
  typeof UpdateA2aRemoteAgentRequestSchema
>;
export type PublicA2aConnection = z.infer<typeof PublicA2aConnectionSchema>;
export type PublicA2aRemoteAgent = z.infer<typeof PublicA2aRemoteAgentSchema>;
export type A2aRemoteAgentInspection = z.infer<
  typeof A2aRemoteAgentInspectionSchema
>;
export type A2aDelegationTarget = z.infer<typeof A2aDelegationTargetSchema>;
