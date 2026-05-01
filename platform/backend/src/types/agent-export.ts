import { IncomingEmailSecurityModeSchema } from "@shared";
import { z } from "zod";
import {
  AgentScopeSchema,
  PassthroughHeadersSchema,
  SelectAgentSchema,
  ToolAssignmentModeSchema,
  ToolExposureModeSchema,
} from "./agent";
import { CredentialResolutionModeSchema } from "./enterprise-managed-credentials";
import { ConnectorTypeSchema } from "./knowledge-connector";

/**
 * Agent Export/Import JSON schema — version 1.
 *
 * Designed for portability across Archestra instances. All references use
 * human-readable names instead of UUIDs so the JSON can be checked into
 * version control and imported into any environment.
 */

// -- Portable reference schemas (names, not IDs) --

const ExportToolReferenceSchema = z.object({
  toolName: z.string().describe("Tool name as registered in the MCP catalog"),
  catalogName: z
    .string()
    .nullable()
    .describe("MCP catalog item name (null for proxy-sniffed tools)"),
  credentialResolutionMode: CredentialResolutionModeSchema.optional().describe(
    "How credentials are resolved for this tool assignment",
  ),
});

const ExportDelegationReferenceSchema = z.object({
  targetAgentName: z
    .string()
    .describe("Name of the target agent for delegation"),
});

const ExportKnowledgeBaseReferenceSchema = z.object({
  name: z.string().describe("Knowledge base name"),
});

const ExportConnectorReferenceSchema = z.object({
  name: z.string().describe("Connector name"),
  connectorType: ConnectorTypeSchema.describe(
    "Connector type (e.g. confluence, github)",
  ),
});

const ExportLabelSchema = z.object({
  key: z.string(),
  value: z.string(),
});

const ExportSuggestedPromptSchema = z.object({
  summaryTitle: z.string(),
  prompt: z.string(),
});

// -- Core agent config schema --

const ExportAgentConfigSchema = z.object({
  name: z.string(),
  agentType: z.literal("agent").describe("Only internal agents are exportable"),
  description: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  icon: z.string().nullable(),
  scope: AgentScopeSchema.describe(
    "Original scope; imports always default to personal",
  ),
  considerContextUntrusted: z.boolean(),
  toolAssignmentMode: ToolAssignmentModeSchema,
  toolExposureMode: ToolExposureModeSchema,
  llmModel: z
    .string()
    .nullable()
    .describe("Informational; not auto-configured on import"),
  incomingEmailEnabled: z.boolean(),
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
  incomingEmailAllowedDomain: z.string().nullable(),
  passthroughHeaders: PassthroughHeadersSchema,
});

// -- Top-level export payload --

export const AgentExportPayloadSchema = z.object({
  version: z.literal("1").describe("Schema version for forward compatibility"),
  exportedAt: z.string().describe("ISO 8601 timestamp"),
  sourceInstance: z
    .string()
    .nullable()
    .optional()
    .describe("Informational: hostname of the source instance"),

  agent: ExportAgentConfigSchema,
  labels: z.array(ExportLabelSchema),
  suggestedPrompts: z.array(ExportSuggestedPromptSchema),
  tools: z.array(ExportToolReferenceSchema),
  delegations: z.array(ExportDelegationReferenceSchema),
  knowledgeBases: z.array(ExportKnowledgeBaseReferenceSchema),
  connectors: z.array(ExportConnectorReferenceSchema),
});

export type AgentExportPayload = z.infer<typeof AgentExportPayloadSchema>;

// -- Import response types --

export const ImportWarningSchema = z.object({
  type: z.enum(["tool", "knowledgeBase", "connector", "delegation"]),
  name: z.string(),
  message: z.string(),
});

export type ImportWarning = z.infer<typeof ImportWarningSchema>;

// -- Import response schema (agent + warnings) --

export const ImportAgentResponseSchema = z.object({
  agent: SelectAgentSchema,
  warnings: z.array(ImportWarningSchema),
});

export type ImportAgentResponse = z.infer<typeof ImportAgentResponseSchema>;
