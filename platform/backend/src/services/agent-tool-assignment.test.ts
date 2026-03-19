import { describe, expect, test } from "vitest";
import type { Tool } from "@/types";
import { validateExecutionSource } from "./agent-tool-assignment";

describe("validateExecutionSource", () => {
  test("accepts prefetched tool data to avoid a redundant tool lookup", async () => {
    const result = await validateExecutionSource({
      toolId: "tool-1",
      preFetchedTool: makeTool({
        id: "tool-1",
        catalogId: "catalog-1",
      }),
      executionSourceMcpServerId: "server-1",
      preFetchedServer: {
        id: "server-1",
        catalogId: "catalog-1",
      },
    });

    expect(result).toBeNull();
  });

  test("returns a validation error when the prefetched execution source comes from another catalog", async () => {
    const result = await validateExecutionSource({
      toolId: "tool-1",
      preFetchedTool: makeTool({
        id: "tool-1",
        catalogId: "catalog-1",
      }),
      executionSourceMcpServerId: "server-1",
      preFetchedServer: {
        id: "server-1",
        catalogId: "catalog-2",
      },
    });

    expect(result).toEqual({
      code: "validation_error",
      error: {
        message:
          "Execution source MCP server must come from the same catalog item as the tool",
        type: "validation_error",
      },
    });
  });
});

function makeTool(overrides: { id: string; catalogId?: string | null }): Tool {
  return {
    id: overrides.id,
    catalogId: overrides.catalogId ?? null,
    name: "test-tool",
    description: null,
    parameters: undefined,
    agentId: null,
    delegateToAgentId: null,
    policiesAutoConfiguredAt: null,
    policiesAutoConfiguringStartedAt: null,
    policiesAutoConfiguredReasoning: null,
    policiesAutoConfiguredModel: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Tool;
}
