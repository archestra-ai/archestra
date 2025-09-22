import { z } from 'zod';

import { PodmanContainerStatusSummarySchema } from '@backend/sandbox/podman/container';
import { PodmanRuntimeStatusSummarySchema } from '@backend/sandbox/podman/runtime';
import { constructToolId } from '@constants';

// AvailableToolSchema and related schemas
export const AvailableToolSchema = z.object({
  id: z.string().describe(`Tool ID in format ${constructToolId('sanitizedServerId', 'sanitizedToolName')}`),
  name: z.string().describe('Tool name'),
  description: z.string().optional().describe('Tool description'),
  inputSchema: z.any().optional().describe('Tool input schema'),
  mcpServerId: z.string().describe('MCP server ID'),
  mcpServerName: z.string().describe('MCP server name'),
  // Analysis results
  analysis: z
    .object({
      status: z.enum(['awaiting_ollama_model', 'in_progress', 'error', 'completed']).describe('Analysis status'),
      error: z.string().nullable().describe('Error message if analysis failed'),
      is_read: z.boolean().nullable().describe('Whether the tool is read-only'),
      is_write: z.boolean().nullable().describe('Whether the tool writes data'),
    })
    .describe('Tool analysis results'),
});

export const McpServerContainerLogsSchema = z.object({
  logs: z.string(),
  containerName: z.string(),
});

export const SandboxedMcpServerStatusSummarySchema = z.object({
  container: PodmanContainerStatusSummarySchema,
  tools: z.array(AvailableToolSchema),
});

export const SandboxStatusSchema = z.enum(['not_installed', 'initializing', 'running', 'error', 'stopping', 'stopped']);

export const SandboxStatusSummarySchema = z.object({
  status: SandboxStatusSchema,
  runtime: PodmanRuntimeStatusSummarySchema,
  mcpServers: z.record(z.string().describe('The MCP server ID'), SandboxedMcpServerStatusSummarySchema),
  // Optional field for all aggregated tools (includes Archestra tools)
  allAvailableTools: z.array(AvailableToolSchema).optional(),
});

// Type exports
export type AvailableTool = z.infer<typeof AvailableToolSchema>;
export type SandboxedMcpServerStatusSummary = z.infer<typeof SandboxedMcpServerStatusSummarySchema>;
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;
export type SandboxStatusSummary = z.infer<typeof SandboxStatusSummarySchema>;

/**
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
z.globalRegistry.add(SandboxStatusSummarySchema, { id: 'SandboxStatusSummary' });
z.globalRegistry.add(PodmanContainerStatusSummarySchema, { id: 'PodmanContainerStatusSummary' });
