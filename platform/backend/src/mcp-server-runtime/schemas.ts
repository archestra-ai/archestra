import { z } from "zod";

export type K8sRuntimeStatus =
  | "not_initialized"
  | "initializing"
  | "running"
  | "error"
  | "stopped";

export type K8sPodState =
  | "not_created"
  | "pending"
  | "running"
  | "failed"
  | "succeeded";

export interface K8sPodStatusSummary {
  state: K8sPodState;
  message: string;
  error: string | null;
  podName: string | null;
  namespace: string;
}

export interface K8sRuntimeStatusSummary {
  status: K8sRuntimeStatus;
  mcpServers: Record<string, K8sPodStatusSummary>;
}

export const AvailableToolAnalysisSchema = z.object({
  status: z.enum(["completed", "awaiting_ollama_model", "error"]),
  error: z.string().nullable(),
  is_read: z.boolean().nullable(),
  is_write: z.boolean().nullable(),
});

export const AvailableToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputSchema: z.any().optional(),
  mcpServerId: z.string(),
  mcpServerName: z.string(),
  analysis: AvailableToolAnalysisSchema,
});

export type AvailableTool = z.infer<typeof AvailableToolSchema>;

export const McpServerContainerLogsSchema = z.object({
  logs: z.string(),
  containerName: z.string(),
  command: z.string(),
  namespace: z.string(),
});

export type McpServerContainerLogs = z.infer<
  typeof McpServerContainerLogsSchema
>;
