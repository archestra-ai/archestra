import type { archestraApiTypes } from "@shared";

export const AUDIT_LOG_SOURCE_LIMIT = 100;

export type AuditEventType = "LLM" | "MCP";
export type AuditEventTypeFilter = AuditEventType | "all";
export type AuditEventStatus = "Allowed" | "Denied" | "Failed";

export type LlmInteraction =
  archestraApiTypes.GetInteractionsResponses["200"]["data"][number];
export type McpToolCall =
  archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number];

export type AuditLogEvent = {
  id: string;
  href: string;
  createdAt: string;
  type: AuditEventType;
  actor: string;
  action: string;
  target: string;
  from: string;
  status: AuditEventStatus;
  summary: string;
};
