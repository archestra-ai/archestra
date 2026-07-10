// biome-ignore-all lint/suspicious/noExplicitAny: test...
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { __test, type ArchestraContext, executeArchestraTool } from ".";
import { archestraMcpBranding } from "./branding";

describe("executeArchestraTool", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeMember, makeOrganization, makeUser }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
    mockContext = {
      agent: {
        id: testAgent.id,
        name: testAgent.name,
      },
      userId: user.id,
      organizationId: org.id,
    };
  });

  describe("unknown tool", () => {
    test("steers an unknown tool name at the discovery path", async () => {
      const error = await executeArchestraTool(
        "unknown_tool",
        undefined,
        mockContext,
      ).catch((e: unknown) => e);

      expect(error).toMatchObject({ code: -32601 });
      const message = (error as { message: string }).message;
      expect(message).toContain('No tool named "unknown_tool" exists');
      expect(message).toContain(
        archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME),
      );
      expect(message).toContain("Do not guess tool names");
    });
  });

  describe("router validation", () => {
    test("rejects invalid tool args centrally with nested paths", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}bulk_assign_tools_to_agents`,
        {
          assignments: [
            {
              agentId: testAgent.id,
              toolId: "not-a-uuid",
            },
          ],
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__bulk_assign_tools_to_agents",
      );
      expect((result.content[0] as any).text).toContain(
        "assignments[0].toolId:",
      );
    });

    test("catches schema errors in one spot and reports the exact nested field", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
        {
          todos: [
            {
              id: 1,
              content: "bad status todo",
              status: "blocked",
            },
          ],
        },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain(
        "Validation error in archestra__todo_write",
      );
      expect((result.content[0] as any).text).toContain("todos[0].status:");
      expect((result.content[0] as any).text).toContain(
        'expected one of "pending"|"in_progress"|"completed"',
      );
    });

    test("returns structuredContent for tools with outputSchema", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}whoami`,
        {},
        mockContext,
      );

      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        agentId: testAgent.id,
        agentName: testAgent.name,
      });
    });

    test("validation errors carry machine-readable _meta.archestraValidation", async () => {
      const result = await executeArchestraTool(
        `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}todo_write`,
        { todos: [{ id: 1, content: "bad status todo", status: "blocked" }] },
        mockContext,
      );

      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({
        archestraValidation: {
          toolName: "archestra__todo_write",
          issues: [{ code: "invalid_value", path: "todos.0.status" }],
        },
      });
    });

    // The handler-thrown ZodError catch in executeArchestraTool shares the
    // same builder; no built-in handler lets a ZodError escape uncaught today
    // (they wrap zod .parse in catchError), so that site is pinned here at the
    // builder level with the schema-less formatting it uses.
    test("zodValidationErrorResult attaches validation meta without a schema", () => {
      const parsed = z
        .strictObject({
          edits: z.array(z.strictObject({ old_str: z.string() })),
        })
        .safeParse({ edits: [{}] });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;

      const result = __test.zodValidationErrorResult({
        toolName: "archestra__edit_app",
        error: parsed.error,
      });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result._meta).toEqual({
        archestraValidation: {
          toolName: "archestra__edit_app",
          issues: [{ code: "invalid_type", path: "edits.0.old_str" }],
        },
      });
    });

    test("catches output schema errors in one spot", () => {
      const result = __test.validateToolResult(
        z.object({ requiredField: z.string() }),
        {
          content: [{ type: "text", text: "bad output" }],
          structuredContent: {},
          isError: false,
        },
        "archestra__test_tool",
      );

      expect("error" in result).toBe(true);
      if ("error" in result) {
        expect((result.error.content[0] as any).text).toContain(
          "Internal output validation error in archestra__test_tool",
        );
        expect((result.error.content[0] as any).text).toContain(
          "requiredField:",
        );
      }
    });
  });
});
