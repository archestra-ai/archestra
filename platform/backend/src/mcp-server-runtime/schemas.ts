import { z } from "zod";

// Common runtime status (used by both K8s and Docker)
export type RuntimeStatus =
  | "not_initialized"
  | "initializing"
  | "running"
  | "error"
  | "stopped";

// K8s-specific types (kept for backward compatibility)
export type K8sRuntimeStatus = RuntimeStatus;

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

// Docker-specific types
export type DockerRuntimeStatus = RuntimeStatus;

export type DockerPodState =
  | "not_created"
  | "pending"
  | "running"
  | "failed"
  | "succeeded";

export interface DockerPodStatusSummary {
  state: DockerPodState;
  message: string;
  error: string | null;
  containerName: string | null;
  containerId: string | null;
}

export interface DockerRuntimeStatusSummary {
  status: DockerRuntimeStatus;
  mcpServers: Record<string, DockerPodStatusSummary>;
}

// Unified runtime status (can be either K8s or Docker)
export type RuntimeType = "kubernetes" | "docker" | "none";

export interface UnifiedRuntimeStatusSummary {
  runtimeType: RuntimeType;
  status: RuntimeStatus;
  mcpServers: Record<string, K8sPodStatusSummary | DockerPodStatusSummary>;
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
