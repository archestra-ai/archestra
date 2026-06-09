import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  isAgentTool,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { evaluateSingleMcpToolInvocationPolicy } from "@/guardrails/tool-invocation";
import logger from "@/logging";
import { ConversationEnabledToolModel, ToolModel } from "@/models";
import { archestraMcpBranding } from "./branding";
import { isToolEnabledForConversation } from "./conversation-tool-filter";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
} from "./helpers";
import {
  toolNotEnabledForConversationMessage,
  unavailableThirdPartyToolMessage,
} from "./tool-recovery-messages";

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
    description: `Dispatch to any tool available to this agent, including built-in platform tools, agent delegation tools ('agent-<id>'), or third-party MCP tools exposed through the MCP Gateway (e.g. 'context7__resolve-library-id'). Pass the tool name exactly as it appears in the tools list or use a built-in platform tool short name like 'whoami' or 'get_agent'. Prefer using ${TOOL_SEARCH_TOOLS_SHORT_NAME} first when you need to discover the right exact name. The target tool must be assigned to this agent; target-tool RBAC, argument validation, and output validation all still apply.`,
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

      // Per-conversation enabled-tool gate: in a chat with a custom tool
      // selection, a tool the user disabled must not be runnable via run_tool
      // (the visible tool list already hides it). Returns an error result when
      // the tool is disabled, else null. Archestra built-ins always pass (and
      // skip the lookup) so run_tool/search_tools themselves are never blocked.
      // conversationId is server-set, never model-supplied, so it cannot be
      // forged to bypass. Callers apply this AFTER the existence/assignment
      // check so an unassigned name still gets the "no such tool" recovery
      // message rather than a misleading "not enabled" one.
      const checkConversationGate = async (
        name: string,
      ): Promise<CallToolResult | null> => {
        if (!context.conversationId || archestraMcpBranding.isToolName(name)) {
          return null;
        }
        const enabledNames =
          await ConversationEnabledToolModel.getEnabledToolNameSet(
            context.conversationId,
          );
        if (isToolEnabledForConversation(name, enabledNames)) {
          return null;
        }
        logger.info(
          { agentId: context.agentId, requestedName, resolvedName: name },
          `${TOOL_RUN_TOOL_SHORT_NAME} dispatched to a tool disabled for this conversation`,
        );
        return errorResult(toolNotEnabledForConversationMessage(name));
      };

      if (route === "archestra") {
        // Delegation (agent-<id>) names are gated here; executeArchestraTool
        // enforces existence/assignment for genuinely unknown archestra names.
        const gateError = await checkConversationGate(resolvedName);
        if (gateError) return gateError;

        // Dynamic import avoids the circular import between this file and
        // ./index (index.ts imports every tool group, including this one).
        const { executeArchestraTool } = await import("./index");
        return executeArchestraTool(resolvedName, args.tool_args, context);
      }

      // Third-party MCP Gateway path. Hallucinated archestra-prefixed names and
      // bogus agent-<id> delegations are handled by the "archestra" route above
      // (executeArchestraTool / checkToolAssignedToAgent), not this check.
      if (!context.agentId) {
        return errorResult(
          `${TOOL_RUN_TOOL_SHORT_NAME} requires agent context to dispatch to third-party MCP tools`,
        );
      }

      // Reject hallucinated or unassigned tool names before policy evaluation.
      // The policy gate below already requires exact membership in this same
      // assigned-tool set (see evaluatePolicies), so checking it here is
      // regression-safe; it lets us return an actionable recovery message
      // instead of the misleading "not enabled for this conversation" refusal
      // (which implies the tool exists). In search_and_run_only mode the
      // intended recovery is search_tools, so we point the model there. The set
      // is reused by the policy gate below so it is fetched only once.
      const assignedToolNames = await ToolModel.getAssignedToolNames(
        context.agentId,
      );
      if (!assignedToolNames.has(resolvedName)) {
        logger.info(
          { agentId: context.agentId, requestedName, resolvedName },
          `${TOOL_RUN_TOOL_SHORT_NAME} dispatched to an unavailable tool`,
        );
        return errorResult(unavailableThirdPartyToolMessage(resolvedName));
      }

      // The tool exists and is assigned — only now enforce the per-conversation
      // selection, so an unassigned name above still gets the recovery message.
      const gateError = await checkConversationGate(resolvedName);
      if (gateError) return gateError;

      const toolInput = args.tool_args ?? {};
      // Reuse the set computed above so the policy gate does not re-query it.
      const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
        agentId: context.agentId,
        toolName: resolvedName,
        toolInput,
        organizationId: context.organizationId,
        contextIsTrusted: context.contextIsTrusted ?? true,
        enforceApprovalRequired: !context.approvalRequiredPoliciesHandled,
        enabledToolNames: assignedToolNames,
      });
      if (policyBlock) {
        return errorResult(policyBlock.refusalMessage);
      }

      const { default: mcpClient } = await import("@/clients/mcp-client");
      const toolCallId = `run-tool-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 9)}`;
      const result = await mcpClient.executeToolCall(
        {
          id: toolCallId,
          name: resolvedName,
          arguments: toolInput,
        },
        context.agentId,
        context.tokenAuth,
        // mcp-client scopes per-conversation sessions (e.g. browser contexts)
        // by this key; headless executions use their isolation key so
        // concurrent runs never share a session and cleanup can close it.
        { conversationId: context.isolationKey ?? context.conversationId },
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
