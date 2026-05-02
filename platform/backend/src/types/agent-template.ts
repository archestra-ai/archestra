import { EnvironmentVariableSchema } from "@shared";
import { z } from "zod";
import { CredentialResolutionModeSchema } from "./enterprise-managed-credentials";
import { UserConfigFieldSchema } from "./mcp-catalog";

export const AgentTemplateLabelSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const AgentTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.string(),
  categories: z.array(z.string()),
  systemPrompt: z.string(),
  llmModel: z.string().nullable(),
  tools: z.array(z.string()),
  labels: z.array(AgentTemplateLabelSchema),
  icon: z.string().nullable(),
});

export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

const TemplateAgentConfigSchema = z.object({
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  llmModel: z.string().nullable(),
  labels: z.array(AgentTemplateLabelSchema),
  agentType: z.literal("agent"),
  scope: z.literal("personal"),
  teams: z.array(z.never()),
});

const TemplateToolAssignmentSchema = z.object({
  toolId: z.string(),
  catalogId: z.string().nullable(),
  credentialResolutionMode: CredentialResolutionModeSchema.optional(),
  requiresUserConfig: z.boolean(),
});

const TemplateUnavailableToolSchema = z.object({
  toolName: z.string(),
  serverName: z.string(),
  reason: z.enum(["catalog_not_found", "tool_not_found", "invalid_tool_name"]),
});

const TemplateUserConfigFieldSchema = UserConfigFieldSchema.extend({
  key: z.string(),
});

const TemplateMissingCatalogSchema = z.object({
  catalogId: z.string(),
  catalogName: z.string(),
  serverType: z.enum(["local", "remote"]),
  requiresOauth: z.boolean(),
  userConfigFields: z.array(TemplateUserConfigFieldSchema),
  environmentFields: z.array(
    EnvironmentVariableSchema.omit({
      value: true,
      default: true,
    }),
  ),
  canAutoInstall: z.boolean(),
});

export const AgentTemplateRequirementsSchema = z.object({
  templateId: z.string(),
  agentConfig: TemplateAgentConfigSchema,
  toolAssignments: z.array(TemplateToolAssignmentSchema),
  missingCatalogs: z.array(TemplateMissingCatalogSchema),
  unavailableTools: z.array(TemplateUnavailableToolSchema),
});

export type AgentTemplateRequirements = z.infer<
  typeof AgentTemplateRequirementsSchema
>;
