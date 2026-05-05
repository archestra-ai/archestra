import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  isAgentTool,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import logger from "@/logging";
import { archestraMcpBranding } from "./branding";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
} from "./helpers";

const RunToolArgsSchema = z
  .object({
    tool_name: z
      .string()
      .min(1)
      .describe(
        "Name of the tool to invoke. Use the exact name as it appears in the tools list, e.g. 'archestra__whoami', 'context7__resolve-library-id', or an agent delegation name 'agent-<id>'.",
      ),
    tool_args: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .describe(
        "Arguments object to pass to the target tool. Put target tool input parameters inside this object. Must match the target tool's input schema.",
      ),
  })
  .strict();

const ARCHESTRA_SHORT_NAME_SET = new Set<string>(ARCHESTRA_TOOL_SHORT_NAMES);
const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_RUN_TOOL_SHORT_NAME,
    title: "Run Tool",
    description: `Dispatch to any tool available to this agent, including built-in platform tools, agent delegation tools ('agent-<id>'), or third-party MCP tools exposed through the MCP Gateway (e.g. 'context7__resolve-library-id'). Pass the tool name exactly as it appears in the tools list or use a built-in platform tool short name like 'whoami' or 'get_agent'. Prefer using ${TOOL_SEARCH_TOOLS_SHORT_NAME} first when you need to discover the right exact name. Target-tool RBAC, argument validation, and output validation all still apply.`,
    schema: RunToolArgsSchema,
    async handler({ args, context }) {
      const requestedName = args.tool_name;

      const isArchestraPrefixed =
        archestraMcpBranding.isToolName(requestedName);
      const isAgentDelegation = isAgentTool(requestedName);
      const isArchestraShortName = ARCHESTRA_SHORT_NAME_SET.has(requestedName);

      const route: "archestra" | "third-party" =
        isArchestraPrefixed || isAgentDelegation || isArchestraShortName
          ? "archestra"
          : "third-party";

      const resolvedName =
        route === "archestra" && isArchestraShortName && !isArchestraPrefixed
          ? getArchestraToolFullName(requestedName as ArchestraToolShortName)
          : requestedName;

      logger.info(
        {
          agentId: context.agentId,
          requestedName,
          resolvedName,
          route,
        },
        `${TOOL_RUN_TOOL_SHORT_NAME} dispatching`,
      );

      const runToolFullName = getArchestraToolFullName(
        TOOL_RUN_TOOL_SHORT_NAME,
      );
      if (resolvedName === runToolFullName) {
        return errorResult(`${TOOL_RUN_TOOL_SHORT_NAME} cannot invoke itself`);
      }

      if (route === "archestra") {
        // Dynamic import avoids the circular import between this file and
        // ./index (index.ts imports every tool group, including this one).
        const { executeArchestraTool } = await import("./index");
        return executeArchestraTool(resolvedName, args.tool_args, context);
      }

      // Third-party MCP Gateway path.
      if (!context.agentId) {
        return errorResult(
          `${TOOL_RUN_TOOL_SHORT_NAME} requires agent context to dispatch to third-party MCP tools`,
        );
      }

      const { default: mcpClient } = await import("@/clients/mcp-client");
      const toolCallId = `run-tool-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
      const result = await mcpClient.executeToolCall(
        {
          id: toolCallId,
          name: resolvedName,
          arguments: args.tool_args,
        },
        context.agentId,
        context.tokenAuth,
        { conversationId: context.conversationId },
      );

      const callToolResult: CallToolResult = {
        content: Array.isArray(result.content)
          ? (result.content as CallToolResult["content"])
          : [{ type: "text", text: JSON.stringify(result.content) }],
        isError: result.isError,
        _meta: result._meta,
        structuredContent: result.structuredContent as
          | Record<string, unknown>
          | undefined,
      };
      return callToolResult;
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
