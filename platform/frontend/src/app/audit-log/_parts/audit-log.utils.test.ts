import { describe, expect, it, vi } from "vitest";

vi.mock("@shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared")>();

  return {
    ...actual,
    DynamicInteraction: class MockDynamicInteraction {
      private interaction: Record<string, unknown>;
      modelName?: string;

      constructor(interaction: Record<string, unknown>) {
        if (interaction.__throwDynamic) {
          throw new Error("invalid interaction");
        }

        this.interaction = interaction;
        this.modelName = interaction.__dynamicModelName as string | undefined;
      }

      getToolNamesRefused() {
        return (this.interaction.__blockedTools as string[] | undefined) ?? [];
      }

      getLastUserMessage() {
        return this.interaction.__lastUserMessage as string | undefined;
      }
    },
    parseFullToolName: (fullToolName: string) => ({
      toolName: fullToolName.split("/").at(-1) ?? fullToolName,
    }),
  };
});

import type {
  AuditLogEvent,
  LlmInteraction,
  McpToolCall,
} from "./audit-log.types";
import {
  buildAuditLogEvents,
  filterAuditLogEvents,
  getAuditLogSummary,
  getLlmAuditEvent,
  getMcpAuditEvent,
  getValidTypeFilter,
} from "./audit-log.utils";

describe("audit-log.utils", () => {
  it("normalizes an invalid type filter to all", () => {
    expect(getValidTypeFilter("LLM")).toBe("LLM");
    expect(getValidTypeFilter("bad-value")).toBe("all");
    expect(getValidTypeFilter(null)).toBe("all");
  });

  it("maps blocked LLM interactions to denied audit events", () => {
    const event = getLlmAuditEvent({
      id: "llm-1",
      createdAt: "2026-04-20T14:42:18.000Z",
      type: "openai:responses",
      model: "gpt-5",
      userId: "alex@company.com",
      source: "Web App",
      __blockedTools: ["postgres.query"],
    } as unknown as LlmInteraction);

    expect(event).toMatchObject({
      id: "llm:llm-1",
      href: "/llm/logs/llm-1",
      type: "LLM",
      actor: "alex@company.com",
      action: "openai.responses",
      target: "gpt-5",
      from: "Web App",
      status: "Denied",
      summary: "Blocked tools: postgres.query",
    });
  });

  it("falls back to dynamic interaction data for allowed LLM events", () => {
    const event = getLlmAuditEvent({
      id: "llm-2",
      createdAt: "2026-04-20T14:31:07.000Z",
      type: "anthropic:messages",
      model: null,
      source: null,
      sessionSource: "API",
      __dynamicModelName: "claude-opus-4",
      __lastUserMessage: "Summarize the quarterly report",
    } as unknown as LlmInteraction);

    expect(event).toMatchObject({
      actor: "Unknown",
      action: "anthropic.messages",
      target: "claude-opus-4",
      from: "API",
      status: "Allowed",
      summary: "Summarize the quarterly report",
    });
  });

  it("maps failed MCP tool calls to failed audit events", () => {
    const event = getMcpAuditEvent({
      id: "mcp-1",
      createdAt: "2026-04-20T14:12:09.000Z",
      method: "tools/call",
      mcpServerName: "Google Drive",
      authMethod: "oauth",
      userName: "agent:legal-review",
      toolCall: {
        name: "google-drive/files.search",
      },
      toolResult: { isError: true },
    } as unknown as McpToolCall);

    expect(event).toMatchObject({
      id: "mcp:mcp-1",
      href: "/mcp/logs/mcp-1",
      type: "MCP",
      actor: "agent:legal-review",
      action: "tools/call",
      target: "files.search",
      from: "OAuth",
      status: "Failed",
      summary: "Called files.search on Google Drive",
    });
  });

  it("builds, sorts, filters, and summarizes audit events", () => {
    const events = buildAuditLogEvents({
      interactions: [
        {
          id: "llm-1",
          createdAt: "2026-04-20T10:00:00.000Z",
          type: "openai:responses",
          model: "gpt-5",
          userId: "alex@company.com",
          source: "Web App",
          __lastUserMessage: "latest forecast",
        } as unknown as LlmInteraction,
      ],
      mcpToolCalls: [
        {
          id: "mcp-1",
          createdAt: "2026-04-20T12:00:00.000Z",
          method: "tools/call",
          mcpServerName: "Postgres",
          authMethod: "org_token",
          userName: "agent:finance",
          toolCall: { name: "postgres/query" },
          toolResult: { isError: false },
        } as unknown as McpToolCall,
      ],
      typeFilter: "all",
    });

    expect(events.map((event) => event.id)).toEqual(["mcp:mcp-1", "llm:llm-1"]);

    const filteredEvents = filterAuditLogEvents({
      events: events as AuditLogEvent[],
      searchQuery: "org token",
    });

    expect(filteredEvents).toHaveLength(1);
    expect(filteredEvents[0]?.id).toBe("mcp:mcp-1");
    expect(getAuditLogSummary(filteredEvents)).toEqual({
      totalCount: 1,
      allowedCount: 1,
      blockedOrFailedCount: 0,
    });
  });
});
