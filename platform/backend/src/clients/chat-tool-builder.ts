// Builds the AI SDK Tool wrappers the chat path exposes to the model: MCP
// gateway tools (with approval gating, lifecycle hooks, browser sync, and MCP
// App output enrichment) and agent delegation tools (plain child-agent
// execution). Must not import chat-mcp-client.ts (cycle).
import { randomUUID } from "node:crypto";
import {
  extractMcpToolError,
  isAppRenderingArchestraToolShortName,
  isBrowserMcpTool,
  parseFullToolName,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import {
  type McpUiToolMeta,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps";
import type {
  CallToolResult,
  ContentBlock,
  EmbeddedResource,
  Tool as McpToolDefinition,
} from "@modelcontextprotocol/sdk/types.js";
import { type JSONSchema7, jsonSchema, type Tool } from "ai";
import { evaluateToolExecutionContextTrust } from "@/agents/context-trust";
import {
  type ArchestraContext,
  archestraMcpBranding,
  executeArchestraTool,
} from "@/archestra-mcp-server";
import { resolveDynamicTool } from "@/archestra-mcp-server/dynamic-tools";
import { resolveRunToolTarget } from "@/archestra-mcp-server/run-tool-target";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import type { SubagentToolStreamBridge } from "@/clients/subagent-tool-stream";
import type {
  RepeatSeverity,
  ToolCallRepeatTracker,
} from "@/clients/tool-call-repeat-tracker";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import { type CollectedHookRun, toCollectedRuns } from "@/hooks/hook-run-parts";
import logger from "@/logging";
import { AgentTeamModel, ToolModel, TrustedDataPolicyModel } from "@/models";
import ToolInvocationPolicyModel from "@/models/tool-invocation-policy";
import { metrics } from "@/observability";
import {
  ATTR_MCP_IS_ERROR_RESULT,
  type SpanTeamInfo,
  startActiveMcpSpan,
} from "@/observability/tracing";
import type { Tool as CatalogTool, UnsafeContextBoundary } from "@/types";
import { agentOwner, UNSAFE_CONTEXT_BOUNDARY_REASON } from "@/types";

/** Gateway token selected for the current call (see selectMCPGatewayToken). */
export interface McpGatewayToken {
  tokenValue: string;
  tokenId: string;
  teamId: string | null;
  isOrganizationToken: boolean;
  isUserToken?: boolean;
}

/**
 * Per-call context shared by every tool wrapper built for one getChatMcpTools
 * call: identity, execution scope, cancellation, and the policy snapshot
 * fetched once per call.
 */
export interface ChatToolContext {
  agentId: string;
  agentName: string;
  userId: string;
  organizationId: string;
  /** Id of a persisted `conversations` row; absent in headless executions. */
  conversationId?: string;
  /** Per-conversation/per-execution scope key (isolationKey ?? conversationId). */
  scopeKey?: string;
  chatOpsBindingId?: string;
  chatOpsThreadId?: string;
  sessionId?: string;
  delegationChain?: string;
  scheduleTriggerRunId?: string;
  abortSignal?: AbortSignal;
  elicitation?: ChatMcpElicitationBridge;
  /** User identity for OTEL span attributes */
  user?: { id: string; email?: string; name?: string };
  /** The agent's teams (with labels) for OTEL span attributes */
  teams?: SpanTeamInfo[];
  /** The requesting user's teams (with labels) for OTEL span attributes */
  userTeams?: SpanTeamInfo[];
  /** Block tool execution when policy is require_approval (A2A/autonomous contexts) */
  blockOnApprovalRequired?: boolean;
  /** Per-turn sink for inline `data-hook-run` entries (chat path only). */
  hookRunCollector?: CollectedHookRun[];
  /**
   * Bridge that surfaces a delegated child agent's tool calls on the caller's
   * conversation surface (chat path only). Threaded into the child run so its
   * tool calls — and those of any deeper descendant — appear nested under the
   * delegation call that spawned them.
   */
  subagentToolStream?: SubagentToolStreamBridge;
  mcpGwToken: McpGatewayToken;
  considerContextUntrusted: boolean;
  /**
   * Per-run guard against the model re-issuing the identical tool call forever.
   * One instance per getChatMcpTools call (shared by every tool wrapper), so it
   * carries no cross-run state.
   */
  repeatTracker: ToolCallRepeatTracker;
}

/**
 * Wraps an MCP gateway tool as an AI SDK Tool: approval gating (including the
 * run_tool grant-approval proposal), PreToolUse/PostToolUse hooks, the
 * archestra-vs-external execution branch, and MCP App output enrichment.
 */
export function buildMcpGatewayTool(params: {
  mcpTool: McpToolDefinition;
  ctx: ChatToolContext;
}): Tool {
  const { mcpTool, ctx } = params;
  const normalizedSchema = normalizeJsonSchema(mcpTool.inputSchema);
  // Only UI-providing tools are advertised top-level unassigned, so only they
  // need the (DB-heavy) dynamic resolution at call time. The gateway emits the
  // same `_meta.ui.resourceUri` it lists top-level with, so this build-time flag
  // matches what resolveDynamicTool would find — computed once here to keep the
  // resolution off the hot path for ordinary assigned tools.
  const isUiProvidingTool = metaProvidesUiResource(
    mcpTool._meta as
      | { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown }
      | undefined,
  );

  return {
    description: mcpTool.description || `Tool: ${mcpTool.name}`,
    inputSchema: jsonSchema(normalizedSchema),
    ...needsApprovalProps({
      toolName: mcpTool.name,
      ctx,
    }),
    execute: async (args: unknown, options) => {
      const toolArguments = isRecord(args) ? args : undefined;
      return executeWithToolSpan({
        toolName: mcpTool.name,
        args,
        spanToolArgs: toolArguments,
        ctx,
        entryLogMessage: "Executing MCP tool from chat (direct)",
        abortLogMessage: "MCP tool execution aborted",
        failureLogMessage: "MCP tool execution failed",
        run: async ({ span, startTime }) => {
          const repeatNudge = applyRepeatedCallBreaker({
            ctx,
            toolName: mcpTool.name,
            toolArguments,
            span,
            startTime,
          });
          if (repeatNudge !== null) {
            return repeatNudge;
          }

          // PreToolUse lifecycle hook: a block short-circuits execution
          // and returns an explanatory tool-result instead of running.
          const preBlockReason = await firePreToolUseHook({
            ctx,
            toolName: mcpTool.name,
            toolInput: toolArguments,
            toolCallId: options.toolCallId,
          });
          if (preBlockReason !== null) {
            span.setAttribute(ATTR_MCP_IS_ERROR_RESULT, true);
            reportToolMetrics({
              toolName: mcpTool.name,
              agentId: ctx.agentId,
              agentName: ctx.agentName,
              startTime,
              isError: true,
            });
            return buildPreToolUseBlockedResult(preBlockReason);
          }

          let toolResult: string | { content: string; [key: string]: unknown };
          if (archestraMcpBranding.isToolName(mcpTool.name)) {
            logger.debug(
              {
                toolName: mcpTool.name,
                scheduleTriggerRunId: ctx.scheduleTriggerRunId ?? null,
                conversationId: ctx.conversationId ?? null,
              },
              "Executing archestra tool with context",
            );
            const toolExecutionContext =
              await evaluateToolExecutionContextTrust({
                messages: options.messages,
                agentId: ctx.agentId,
                organizationId: ctx.organizationId,
                userId: ctx.userId,
                considerContextUntrusted: ctx.considerContextUntrusted,
                policyContext: {
                  externalAgentId: getChatExternalAgentId(),
                },
              });
            const archestraResponse = await executeArchestraTool(
              mcpTool.name,
              toolArguments,
              {
                agent: { id: ctx.agentId, name: ctx.agentName },
                conversationId: ctx.conversationId,
                isolationKey: ctx.scopeKey,
                chatOpsBindingId: ctx.chatOpsBindingId,
                chatOpsThreadId: ctx.chatOpsThreadId,
                userId: ctx.userId,
                agentId: ctx.agentId,
                organizationId: ctx.organizationId,
                sessionId: ctx.sessionId,
                scheduleTriggerRunId: ctx.scheduleTriggerRunId,
                abortSignal: ctx.abortSignal,
                elicitation: ctx.elicitation,
                contextIsTrusted: toolExecutionContext.contextIsTrusted,
                // `run_tool` can dispatch a delegation tool, so this context
                // needs the caller's ancestors for the executor's cycle check.
                delegationChain: ctx.delegationChain,
                approvalRequiredPoliciesHandled: true,
                tokenAuth: buildTokenAuthContext({
                  mcpGwToken: ctx.mcpGwToken,
                  organizationId: ctx.organizationId,
                  userId: ctx.userId,
                }),
              },
            );

            span.setAttribute(
              ATTR_MCP_IS_ERROR_RESULT,
              archestraResponse.isError ?? false,
            );
            reportToolMetrics({
              toolName: mcpTool.name,
              agentId: ctx.agentId,
              agentName: ctx.agentName,
              startTime,
              isError: archestraResponse.isError ?? false,
            });

            // Archestra tool errors (schema/validation, policy, not-found,
            // stale-version) are a function of the arguments, so an identical
            // re-issue won't resolve them; let the repeat breaker nudge a step
            // sooner (the first retry still runs — see noteDeterministicError).
            if (archestraResponse.isError) {
              ctx.repeatTracker.noteDeterministicError(
                mcpTool.name,
                toolArguments,
              );
            }

            // Return errors as tool-result text so the LLM can read
            // and recover, instead of throwing (which surfaces as a
            // fatal chat error). Matches executeMcpTool behavior.
            // When run_tool dispatches to an interactive tool, attach
            // that tool's MCP App UI resource so the frontend renders it
            // (the model still only sees the plain-text summary).
            toolResult = await buildArchestraToolOutput({
              response: archestraResponse,
              toolName: mcpTool.name,
              toolArguments,
              agentId: ctx.agentId,
              userId: ctx.userId,
              organizationId: ctx.organizationId,
              tokenAuth: buildTokenAuthContext({
                mcpGwToken: ctx.mcpGwToken,
                organizationId: ctx.organizationId,
                userId: ctx.userId,
              }),
            });
          } else {
            // Execute non-Archestra tools via shared helper with browser sync
            toolResult = await executeMcpTool({
              toolName: mcpTool.name,
              toolArguments,
              agentId: ctx.agentId,
              agentName: ctx.agentName,
              userId: ctx.userId,
              organizationId: ctx.organizationId,
              isolationKey: ctx.scopeKey,
              mcpGwToken: ctx.mcpGwToken,
              considerContextUntrusted: ctx.considerContextUntrusted,
              abortSignal: ctx.abortSignal,
              elicitation: ctx.elicitation,
              isUiProvidingTool,
            });
          }

          // PostToolUse lifecycle hook: append any block feedback to the
          // tool result the model sees, preserving its shape.
          const postFeedback = await firePostToolUseHook({
            ctx,
            toolName: mcpTool.name,
            toolInput: toolArguments,
            toolResponse: toolResultText(toolResult),
            toolCallId: options.toolCallId,
          });
          return postFeedback
            ? appendHookFeedbackToToolResult(toolResult, postFeedback)
            : toolResult;
        },
      });
    },
    // Strip UI-only fields (structuredContent, rawContent, _meta) so the LLM
    // only receives the plain-text `content` summary (SEP-1865).
    toModelOutput: mcpToolToModelOutput,
  };
}

/**
 * Wraps an agent delegation tool as an AI SDK Tool: approval gating and direct
 * child-agent execution returning plain text. No lifecycle hooks, browser
 * sync, or output enrichment — those are chat/MCP-tool concerns.
 */
export function buildAgentDelegationTool(params: {
  agentTool: McpToolDefinition;
  ctx: ChatToolContext;
}): Tool {
  const { agentTool, ctx } = params;
  const normalizedSchema = normalizeJsonSchema(agentTool.inputSchema);

  const archestraContext: ArchestraContext = {
    agent: { id: ctx.agentId, name: ctx.agentName },
    agentId: ctx.agentId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    isolationKey: ctx.scopeKey,
    chatOpsBindingId: ctx.chatOpsBindingId,
    chatOpsThreadId: ctx.chatOpsThreadId,
    sessionId: ctx.sessionId,
    scheduleTriggerRunId: ctx.scheduleTriggerRunId,
    delegationChain: ctx.delegationChain,
    abortSignal: ctx.abortSignal,
    tokenAuth: buildTokenAuthContext({
      mcpGwToken: ctx.mcpGwToken,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    }),
  };

  return {
    description: agentTool.description || `Agent tool: ${agentTool.name}`,
    inputSchema: jsonSchema(normalizedSchema),
    ...needsApprovalProps({
      toolName: agentTool.name,
      ctx,
    }),
    execute: async (args: Record<string, unknown>, options) =>
      executeWithToolSpan({
        toolName: agentTool.name,
        args,
        spanToolArgs: args,
        ctx,
        entryLogMessage: "Executing agent tool from chat",
        abortLogMessage: "Agent tool execution aborted",
        failureLogMessage: "Agent tool execution failed",
        run: async ({ span, startTime }) => {
          // Repeated identical delegation calls loop too — and each one spawns a
          // child-agent run, so breaking the loop here matters more, not less.
          const repeatNudge = applyRepeatedCallBreaker({
            ctx,
            toolName: agentTool.name,
            toolArguments: args,
            span,
            startTime,
          });
          if (repeatNudge !== null) {
            return repeatNudge;
          }

          const toolExecutionContext = await evaluateToolExecutionContextTrust({
            messages: options.messages,
            agentId: ctx.agentId,
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            considerContextUntrusted: ctx.considerContextUntrusted,
            policyContext: {
              externalAgentId: getChatExternalAgentId(),
            },
          });
          const response = await executeArchestraTool(agentTool.name, args, {
            ...archestraContext,
            contextIsTrusted: toolExecutionContext.contextIsTrusted,
            // Surface the child's tool calls on the caller's conversation,
            // attributed to this delegation call (options.toolCallId).
            subagentToolStream: ctx.subagentToolStream,
            currentToolCallId: options.toolCallId,
          });

          span.setAttribute(
            ATTR_MCP_IS_ERROR_RESULT,
            response.isError ?? false,
          );
          reportToolMetrics({
            toolName: agentTool.name,
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            startTime,
            isError: response.isError ?? false,
          });

          return response.content
            .map((item) =>
              item.type === "text" ? item.text : JSON.stringify(item),
            )
            .join("\n");
        },
      }),
  };
}

/**
 * Converts the rich output of `executeMcpTool` into a plain text model output.
 * Strips UI-only fields (structuredContent, rawContent, _meta) so the LLM
 * only receives the plain-text `content` summary (SEP-1865).
 * @public — exported for testability
 */
export function mcpToolToModelOutput({
  output,
}: {
  output:
    | string
    | {
        content: string;
        _meta?: unknown;
        structuredContent?: unknown;
        rawContent?: unknown;
      };
}):
  | { type: "text"; value: string }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | { type: "media"; data: string; mediaType: string }
      >;
    } {
  if (typeof output === "string") return { type: "text", value: output };
  const images = extractModelOutputImages(output.rawContent);
  if (images.length === 0) return { type: "text", value: output.content };
  return {
    type: "content",
    value: [
      { type: "text" as const, text: output.content },
      ...images.map((img) => ({
        type: "media" as const,
        data: img.data,
        mediaType: img.mediaType,
      })),
    ],
  };
}

// A tool result's images only reach the model when bounded: a base64 payload
// larger than this, or more than a couple of images, is dropped (the text
// summary still goes through). Matches the screenshot ingest cap.
const MAX_MODEL_OUTPUT_IMAGE_BASE64_LENGTH = 2_000_000;
const MAX_MODEL_OUTPUT_IMAGES = 2;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
function extractModelOutputImages(
  rawContent: unknown,
): Array<{ data: string; mediaType: string }> {
  if (!Array.isArray(rawContent)) return [];
  const images: Array<{ data: string; mediaType: string }> = [];
  for (const block of rawContent) {
    if (
      isRecord(block) &&
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string" &&
      block.data.length <= MAX_MODEL_OUTPUT_IMAGE_BASE64_LENGTH &&
      // reject a history-stripped placeholder (the strip pass blanks the base64
      // but leaves the image block) so it isn't re-forwarded as garbage media
      BASE64_PATTERN.test(block.data)
    ) {
      images.push({ data: block.data, mediaType: block.mimeType });
      if (images.length >= MAX_MODEL_OUTPUT_IMAGES) break;
    }
  }
  return images;
}

/**
 * Builds the chat tool output for an Archestra tool result. Returns plain text
 * for the common case; when run_tool dispatched to an interactive tool, returns
 * the rich shape (with `_meta.ui.resourceUri` from the target tool's definition)
 * so the frontend renders the MCP App — mirroring how `executeMcpTool` enriches
 * directly-called tools. The target's UI resource is resolved from its
 * assignment, or (for an "all tools" agent) from the user's dynamic-access set.
 * @public — exported for testability
 */
export async function buildArchestraToolOutput(params: {
  response: CallToolResult;
  toolName: string;
  toolArguments: unknown;
  agentId: string;
  /**
   * Caller identity used to resolve the dispatched target tool's UI resource
   * when the tool is reachable only through dynamic access ("all tools" mode)
   * and has no `agent_tools` assignment. Omit for callers that never dispatch
   * unassigned tools; the resolution then stays assignment-scoped.
   */
  userId?: string;
  organizationId?: string;
  /**
   * Caller auth used to resolve the concrete install (own→team→org) backing a
   * run_tool-dispatched external MCP App's UI resource, so its callbacks bind to
   * that install. Omit when the caller can't reach external UI tools; the app
   * then renders without a server binding (unchanged legacy behaviour).
   */
  tokenAuth?: TokenAuthContext;
}): Promise<
  | string
  | {
      content: string;
      _meta?: Record<string, unknown>;
      structuredContent?: Record<string, unknown>;
      rawContent?: ContentBlock[];
    }
> {
  const {
    response,
    toolName,
    toolArguments,
    agentId,
    userId,
    organizationId,
    tokenAuth,
  } = params;
  // Never stringify an image block into the text summary — its base64 would
  // bloat context and evade the history image-stripper. Images ride rawContent
  // and reach the model as bounded media parts via toModelOutput instead.
  const text = response.content
    .map((item) =>
      item.type === "text"
        ? item.text
        : item.type === "image"
          ? "[image]"
          : JSON.stringify(item),
    )
    .join("\n");

  // Carry self-captured images (e.g. a get_app_diagnostics render screenshot)
  // through so the model can see them — toModelOutput turns them into media
  // parts, bounded by size/count there. Image-free results are unaffected.
  if (!response.isError && response.content.some((c) => c.type === "image")) {
    return { content: text, rawContent: response.content as ContentBlock[] };
  }

  const targetToolName = resolveRunToolTargetName(toolName, toolArguments);

  // App-management results identify an owned app via structuredContent.id;
  // the chat frontend mounts the app-bound runtime from it, so keep the rich
  // shape. Scoped to the app trio — other Archestra tools stay plain text
  // (e.g. knowledge-source citations parse the plain output).
  const targetShortName = archestraMcpBranding.getToolShortName(targetToolName);
  // run_tool also accepts bare archestra short names (see run-tool.ts routing);
  // a bare name can only be a run_tool target — direct chat tool names are
  // always server-prefixed.
  const matchesAppTrio =
    targetShortName !== null
      ? isAppRenderingArchestraToolShortName(targetShortName)
      : isAppRenderingArchestraToolShortName(targetToolName);
  if (
    matchesAppTrio &&
    !response.isError &&
    isRecord(response.structuredContent)
  ) {
    return {
      content: text,
      structuredContent: response.structuredContent,
      rawContent: response.content as ContentBlock[],
    };
  }

  if (targetToolName === toolName) {
    // Not a run_tool dispatch — no UI resource to attach.
    return text;
  }

  let resourceUri: string | undefined;
  try {
    // Assigned tools resolve directly. A tool the agent reaches only through
    // dynamic access ("all tools" mode) has no `agent_tools` row, so fall back
    // to the same user-scoped resolution run_tool used to dispatch it —
    // otherwise its MCP App UI resource is dropped and the app renders as a
    // plain tool-call card instead of an iframe.
    const toolDef =
      (await ToolModel.findByNameForAgent(targetToolName, agentId)) ??
      (userId && organizationId
        ? await resolveDynamicTool({
            toolName: targetToolName,
            agentId,
            userId,
            organizationId,
          })
        : null);
    resourceUri = (
      toolDef?.meta as { _meta?: { ui?: McpUiToolMeta } } | undefined
    )?._meta?.ui?.resourceUri;
  } catch (error) {
    logger.debug(
      { error, targetToolName, agentId },
      "Failed to fetch dispatched tool definition meta",
    );
  }
  // Drop the resource when its upstream server can't actually serve it (e.g.
  // -32601), so the dispatch falls through to the plain-result handling below
  // instead of registering an app that renders nothing. See uiResourceIsReadable.
  if (
    resourceUri &&
    !(await uiResourceIsReadable({ uri: resourceUri, agentId, tokenAuth }))
  ) {
    resourceUri = undefined;
  }
  if (!resourceUri) {
    // A dispatched third-party tool with no MCP-App UI. If it returned a
    // structured Archestra error (e.g. the expired-auth re-auth payload),
    // preserve `_meta`/`structuredContent` so chat renders the same rich card
    // as a direct call. The bare-text fallback below strips
    // `_meta.archestraError`/`structuredContent.archestraError`, degrading the
    // card to a text-parsed one (which loses e.g. the credential scope). Mirrors
    // the direct path (executeMcpTool), which keeps these fields on error.
    if (response.isError && extractMcpToolError(response)) {
      return {
        content: text,
        _meta: response._meta as Record<string, unknown> | undefined,
        structuredContent: response.structuredContent as
          | Record<string, unknown>
          | undefined,
        rawContent: response.content as ContentBlock[],
      };
    }
    return text;
  }

  // Bind the app's callbacks to the concrete install so its SDK `callServerTool`
  // reaches the originating server (POST /api/mcp/server/:id) rather than the
  // agent gateway (which rejects the bare tool name). This run_tool path is how
  // an all-tools agent opens an external app — the tool is unassigned, so only
  // the dynamic-access resolution above (and this install lookup) can bind it.
  // Owned-app backings resolve to null and keep their app-id routing.
  const mcpServerId = await mcpClient
    .resolveUiAppInstallIdForCaller(resourceUri, agentId, tokenAuth)
    .catch(() => null);

  return {
    content: text,
    _meta: {
      ...response._meta,
      ui: { resourceUri, ...(mcpServerId ? { mcpServerId } : {}) },
    },
    structuredContent: response.structuredContent as
      | Record<string, unknown>
      | undefined,
    rawContent: response.content as ContentBlock[],
  };
}

/** @public — exported for testability */
export const __test = {
  normalizeJsonSchema,
  executeMcpTool,
  resolveApprovalPolicyTarget,
  throwIfApprovalRequired,
  // Hook helpers — exposed for focused unit tests
  firePreToolUseHook,
  firePostToolUseHook,
  appendHookFeedbackToToolResult,
  buildPreToolUseBlockedResult,
  toolResultText,
};

// === Internal helpers ===

/**
 * MIME types that indicate a renderable UI resource (SEP-1865).
 * `text/html;profile=mcp-app` is the canonical type per the spec;
 */
const RENDERABLE_UI_MIME_TYPES = [RESOURCE_MIME_TYPE];

function getChatExternalAgentId(): string {
  return `${archestraMcpBranding.catalogName} Chat`;
}

/**
 * The `needsApproval` property for a tool wrapper, or nothing when the caller
 * blocks approval-required execution outright (A2A/autonomous contexts).
 */
function needsApprovalProps(params: {
  toolName: string;
  ctx: ChatToolContext;
}): Pick<Tool, "needsApproval"> | Record<string, never> {
  const { toolName, ctx } = params;
  if (ctx.blockOnApprovalRequired) {
    return {};
  }
  return {
    needsApproval: async (args: unknown) => {
      const approvalTarget = resolveApprovalPolicyTarget(toolName, args);
      return ToolInvocationPolicyModel.checkApprovalRequired(
        approvalTarget.toolName,
        approvalTarget.toolInput,
        {
          teamIds: [],
          externalAgentId: getChatExternalAgentId(),
        },
      );
    },
  };
}

/**
 * The execute skeleton shared by both tool kinds: the autonomous approval
 * block, the entry log, the MCP span, the abort check, and the catch that
 * reports an error metric and logs abort-vs-failure before rethrowing. The
 * kind-specific body (including its own success metrics and span attributes)
 * runs as `run`.
 */
async function executeWithToolSpan<R>(params: {
  toolName: string;
  args: unknown;
  spanToolArgs: Record<string, unknown> | undefined;
  ctx: ChatToolContext;
  entryLogMessage: string;
  abortLogMessage: string;
  failureLogMessage: string;
  run: (callContext: {
    span: Parameters<Parameters<typeof startActiveMcpSpan>[0]["callback"]>[0];
    startTime: number;
  }) => Promise<R>;
}): Promise<R> {
  const {
    toolName,
    args,
    spanToolArgs,
    ctx,
    entryLogMessage,
    abortLogMessage,
    failureLogMessage,
    run,
  } = params;

  if (ctx.blockOnApprovalRequired) {
    await throwIfApprovalRequired(toolName, args);
  }

  logger.info(
    { agentId: ctx.agentId, userId: ctx.userId, toolName, arguments: args },
    entryLogMessage,
  );

  const { serverName } = parseFullToolName(toolName);
  const startTime = Date.now();

  return startActiveMcpSpan({
    toolName,
    mcpServerName: serverName ?? "unknown",
    agent: { id: ctx.agentId, name: ctx.agentName },
    teams: ctx.teams,
    userTeams: ctx.userTeams,
    sessionId: ctx.sessionId,
    toolArgs: spanToolArgs,
    user: ctx.user,
    callback: async (span) => {
      try {
        throwIfAborted(ctx.abortSignal);
        return await run({ span, startTime });
      } catch (error) {
        const aborted = ctx.abortSignal?.aborted || isAbortLikeError(error);
        // A stopped run is a cancellation, not a tool failure — don't count it.
        if (!aborted) {
          reportToolMetrics({
            toolName,
            agentId: ctx.agentId,
            agentName: ctx.agentName,
            startTime,
            isError: true,
          });
        }
        const logPayload = {
          agentId: ctx.agentId,
          userId: ctx.userId,
          toolName,
          err: error,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        if (aborted) {
          logger.info(logPayload, abortLogMessage);
        } else {
          logger.error(logPayload, failureLogMessage);
        }
        throw error;
      }
    },
  });
}

/**
 * Context for MCP tool execution with browser sync support.
 */
interface ToolExecutionContext {
  toolName: string;
  toolArguments: Record<string, unknown> | undefined;
  agentId: string;
  agentName: string;
  userId: string;
  organizationId: string;
  /**
   * Per-conversation/per-execution scope key for browser tab selection and
   * MCP session reuse. Equals the conversation id in UI chat.
   */
  isolationKey?: string;
  mcpGwToken: Pick<
    McpGatewayToken,
    "tokenId" | "teamId" | "isOrganizationToken"
  > | null;
  considerContextUntrusted: boolean;
  abortSignal?: AbortSignal;
  elicitation?: ChatMcpElicitationBridge;
  /**
   * Set when the tool's gateway-listed definition carries a `ui://` resource,
   * i.e. it may be advertised top-level while unassigned. Gates the dynamic
   * availableTool resolution so ordinary assigned tools skip its DB lookups.
   */
  isUiProvidingTool?: boolean;
}

/**
 * Shared helper for executing MCP tools with browser state synchronization.
 * Handles:
 * - Browser tab selection for browser tools
 * - MCP tool execution via mcpClient
 * - Browser state sync (tabs and navigation)
 * - Content conversion to string format
 *
 * @returns The tool result as a string and metadata for the UI renderer
 * @throws Error if tool execution fails
 */
async function executeMcpTool(ctx: ToolExecutionContext): Promise<{
  content: string;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  rawContent?: ContentBlock[];
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  const {
    toolName,
    toolArguments,
    agentId,
    agentName,
    userId,
    organizationId,
    isolationKey,
    mcpGwToken,
    abortSignal,
    elicitation,
    isUiProvidingTool,
  } = ctx;
  throwIfAborted(abortSignal);
  const startTime = Date.now();

  // For browser tools, ensure the correct conversation tab is selected first
  const { browserStreamFeature } = await import(
    "@/features/browser-stream/services/browser-stream.feature"
  );

  if (
    isolationKey &&
    isBrowserMcpTool(toolName) &&
    browserStreamFeature.isEnabled()
  ) {
    logger.debug(
      { agentId, userId, isolationKey, toolName },
      "Selecting conversation browser tab before executing browser tool",
    );

    const tabResult = await browserStreamFeature.selectOrCreateTab(
      agentId,
      isolationKey,
      { userId, organizationId },
    );

    if (!tabResult.success) {
      logger.warn(
        { agentId, isolationKey, toolName, error: tabResult.error },
        "Failed to select conversation tab for browser tool, continuing anyway",
      );
    }
  }

  const toolCall = {
    id: randomUUID(),
    name: toolName,
    arguments: toolArguments ?? {},
  };

  // An all-tools agent advertises unassigned UI-providing tools (app/external
  // launch tools) top-level so a model can call one directly — an MCP-App host
  // renders a UI only from a tool listed at discovery time, never from a
  // run_tool result. Dispatch accepts an unassigned tool only via a pre-resolved
  // availableTool, so resolve it exactly as the gateway CallTool handler and
  // run_tool do (resolveDynamicTool self-gates on the agent's all-tools
  // setting), gated to the UI-providing subset: only that subset is listed
  // top-level, so resolving anything else would make a hidden tool name directly
  // executable. isUiProvidingTool (from the gateway-listed `_meta`) keeps the
  // DB-heavy resolution off the hot path for ordinary assigned tools, which
  // never carry a `ui://` resource and would discard the result at the guard
  // below anyway.
  let availableTool: CatalogTool | undefined;
  if (isUiProvidingTool && userId && organizationId) {
    const dynamicTool = await resolveDynamicTool({
      toolName,
      agentId,
      userId,
      organizationId,
    });
    if (dynamicTool && toolProvidesUiResource(dynamicTool)) {
      availableTool = dynamicTool;
    }
  }

  // Caller auth for install resolution (own→team→org), reused below to verify a
  // declared UI resource is readable with the exact same scoping the execution used.
  const tokenAuthContext = mcpGwToken
    ? {
        tokenId: mcpGwToken.tokenId,
        teamId: mcpGwToken.teamId,
        isOrganizationToken: mcpGwToken.isOrganizationToken,
        organizationId,
        userId,
      }
    : undefined;

  let result: Awaited<ReturnType<typeof mcpClient.executeToolCallForOwner>>;
  try {
    result = await mcpClient.executeToolCallForOwner(
      toolCall,
      agentOwner(agentId),
      tokenAuthContext,
      {
        ...(availableTool ? { availableTool } : {}),
        // mcp-client scopes per-conversation sessions by this key; in UI chat it
        // is the conversation id, in headless executions the execution key.
        conversationId: isolationKey,
        // Cancels the in-flight upstream call when the chat run is stopped,
        // instead of letting it run to completion past the post-call
        // throwIfAborted below. Covers subagents too (shared builder).
        abortSignal,
        ...(elicitation
          ? { elicitationHandler: elicitation.createHandler({ toolName }) }
          : {}),
      },
    );
    reportToolMetrics({
      toolName,
      agentId,
      agentName,
      startTime,
      isError: result.isError ?? false,
    });
  } catch (error) {
    // A stopped run aborts the call mid-flight; that is a cancellation, not a
    // tool failure, so don't count it as an error.
    if (!abortSignal?.aborted) {
      reportToolMetrics({
        toolName,
        agentId,
        agentName,
        startTime,
        isError: true,
      });
    }
    throw error;
  }
  throwIfAborted(abortSignal);

  // The MCP path always returns ContentBlock[] in content — narrow from unknown.
  const mcpContent = result.content as ContentBlock[];

  // Check if MCP tool returned an error
  // Return error text as tool result instead of throwing so the AI SDK includes
  // it in the conversation as a tool-result message. This allows the frontend to
  // parse structured errors (e.g. auth-required with action URL) and render
  // actionable UI instead of showing a generic stream error.
  if (result.isError) {
    const extractedError = mcpContent
      ?.map((item) => (item.type === "text" ? item.text : JSON.stringify(item)))
      .join("\n");
    return {
      content: extractedError || result.error || "Tool execution failed",
      ...(await buildUnsafeContextBoundaryResult({
        resultMeta: result._meta,
        toolCallId: toolCall.id,
        toolName,
        toolOutput: extractedError || result.error || "Tool execution failed",
        agentId,
        considerContextUntrusted: ctx.considerContextUntrusted,
      })),
      structuredContent: result.structuredContent,
      rawContent: Array.isArray(result.content)
        ? (result.content as ContentBlock[])
        : undefined,
    };
  }

  logger.debug(
    { isolationKey, toolName, isEnabled: browserStreamFeature.isEnabled() },
    "[executeMcpTool] Checking browser sync conditions",
  );
  if (isolationKey && browserStreamFeature.isEnabled()) {
    // Sync URL for browser_navigate (but not browser_navigate_back/forward)
    const isNavigateTool =
      toolName.endsWith("browser_navigate") ||
      toolName.endsWith("__navigate") ||
      (toolName.includes("playwright") &&
        toolName.includes("navigate") &&
        !toolName.includes("_back") &&
        !toolName.includes("_forward"));
    logger.debug(
      { toolName, isNavigateTool, isolationKey },
      "[executeMcpTool] Checking navigate sync condition",
    );
    if (isNavigateTool) {
      logger.info(
        { toolName, agentId, isolationKey },
        "[executeMcpTool] Syncing URL from navigate tool call",
      );
      await browserStreamFeature.syncUrlFromNavigateToolCall({
        agentId,
        conversationId: isolationKey,
        userContext: { userId, organizationId },
        toolResultContent: mcpContent,
      });
    }
  }

  // Convert MCP content to string for AI SDK
  // Handles standard content types: text, image, resource (embedded UI resources)
  const hasRenderableUI = mcpContent.some(
    (item) =>
      item.type === "resource" &&
      RENDERABLE_UI_MIME_TYPES.includes(item.resource.mimeType ?? ""),
  );

  let textContent: string;
  if (hasRenderableUI) {
    // When a UI is rendered, give the LLM almost nothing to work with.
    // No data, no descriptions - just a terse confirmation. This prevents
    // verbose LLM responses that describe or explain the already-visible UI.
    textContent = "OK";
  } else {
    textContent = mcpContent
      .map((item) => {
        if (item.type === "text") {
          return item.text;
        }
        if (item.type === "resource") {
          if ("text" in item.resource) return item.resource.text;
          return `[Resource: ${item.resource.uri}]`;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }

  // The _meta block from tool definitions, containing the ui sub-object (SEP-1865).
  type ToolDefinitionMeta = { ui?: McpUiToolMeta; [key: string]: unknown };

  // Fetch tool definition to get _meta.ui.resourceUri for MCP Apps
  // Per SEP-1865, tool definitions declare _meta.ui.resourceUri to link tools to their UI
  // The tools table stores: meta = { _meta: { ui: { resourceUri: "..." } }, annotations: {...} }
  // Scoped to agent to prevent cross-org metadata leak (findByName is unscoped).
  let toolDefinitionMeta: ToolDefinitionMeta | undefined;
  try {
    const toolDef = await ToolModel.findByNameForAgent(toolName, agentId);
    if (toolDef?.meta) {
      // Extract _meta from the stored structure: { _meta: {...}, annotations: {...} }
      toolDefinitionMeta = (toolDef.meta as { _meta?: ToolDefinitionMeta })
        ?._meta;
    }
  } catch (error) {
    logger.debug(
      { error, toolName, agentId },
      "Failed to fetch tool definition meta",
    );
  }

  // A tool definition can declare a `ui://` MCP App resource its upstream server
  // never actually serves (e.g. resources/read → -32601 Method not found).
  // Keeping it would register an app that renders nothing — an empty pill and an
  // auto-opened, blank right panel — so drop the declared resource when it can't
  // be read, letting the tool render as a plain call. An embedded inline resource
  // (below) is self-contained and re-synthesizes the ui after this check.
  const declaredUiResourceUri = toolDefinitionMeta?.ui?.resourceUri;
  if (
    declaredUiResourceUri &&
    toolDefinitionMeta?.ui &&
    !(await uiResourceIsReadable({
      uri: declaredUiResourceUri,
      agentId,
      tokenAuth: tokenAuthContext,
    }))
  ) {
    const { resourceUri: _unreadable, ...uiWithoutResource } =
      toolDefinitionMeta.ui;
    toolDefinitionMeta = { ...toolDefinitionMeta, ui: uiWithoutResource };
  }

  // Check for embedded resources (type: "resource" content items with UI resources)
  // MCP servers can return UI resources inline in tool results as an alternative to
  // declaring _meta.ui.resourceUri in tool definitions. Both patterns are standard MCP.
  const resourceItems = mcpContent.filter(
    (item): item is EmbeddedResource => item.type === "resource",
  );
  // Prefer renderable resources (text/html) over data resources (application/json, etc.)
  const embeddedResourceItem =
    resourceItems.find((item) =>
      RENDERABLE_UI_MIME_TYPES.includes(item.resource.mimeType ?? ""),
    ) ?? resourceItems[0];

  if (embeddedResourceItem && !toolDefinitionMeta?.ui?.resourceUri) {
    // Synthesize _meta.ui from the embedded resource so frontend can detect and render it
    toolDefinitionMeta = {
      ...toolDefinitionMeta,
      ui: {
        ...toolDefinitionMeta?.ui,
        resourceUri: embeddedResourceItem.resource.uri,
      },
    };
  }

  // Merge tool definition meta with result meta (tool definition takes precedence for ui.resourceUri)
  const mergedMeta = {
    ...result._meta,
    ...toolDefinitionMeta,
  };

  if (toolDefinitionMeta || result.structuredContent) {
    logger.debug(
      {
        toolName,
        hasToolDefinitionMeta: !!toolDefinitionMeta,
        hasStructuredContent: !!result.structuredContent,
        uiResourceUri: toolDefinitionMeta?.ui?.resourceUri,
      },
      "MCP Apps: Tool result with metadata for AppRenderer",
    );
  }

  return {
    content: textContent,
    ...(await buildUnsafeContextBoundaryResult({
      resultMeta: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
      toolCallId: toolCall.id,
      toolName,
      toolOutput: result.structuredContent ?? textContent,
      agentId,
      considerContextUntrusted: ctx.considerContextUntrusted,
    })),
    structuredContent: result.structuredContent,
    rawContent: mcpContent,
  };
}

/**
 * Resolves the tool whose definition carries the MCP App UI resource. For a
 * direct call this is the tool itself; for a run_tool dispatch it is the target
 * tool named in `tool_args` — run_tool itself has no UI resource, so without
 * this the interactive app never renders when invoked indirectly.
 */
function resolveRunToolTargetName(toolName: string, args: unknown): string {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (shortName !== TOOL_RUN_TOOL_SHORT_NAME || !isRecord(args)) {
    return toolName;
  }
  const targetToolName = args.tool_name;
  return typeof targetToolName === "string" && targetToolName.length > 0
    ? targetToolName
    : toolName;
}

// Whether a tool's `_meta` carries an MCP App `ui://` resource — the subset
// advertised top-level and therefore directly dispatchable. Mirrors
// `providesUiResource` in the gateway's tools/list builder; kept local to avoid
// a clients → routes import.
function metaProvidesUiResource(
  meta:
    | { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown }
    | null
    | undefined,
): boolean {
  const isUiUri = (value: unknown): boolean =>
    typeof value === "string" && value.startsWith("ui://");
  return isUiUri(meta?.ui?.resourceUri) || isUiUri(meta?.["ui/resourceUri"]);
}

/**
 * Whether an MCP App `ui://` UI resource can actually be read from its upstream
 * server. A tool may advertise a resource its server never implements
 * (`resources/read` → -32601 Method not found) or otherwise can't serve;
 * attaching such a resource to a tool result makes chat register an app that
 * renders nothing — an empty pill plus an auto-opened, blank right panel. Both
 * enrichment paths (executeMcpTool and buildArchestraToolOutput) gate the
 * attachment on this, mirroring the SSE prefetch's own readability gate
 * (tool-ui-stream). A successful read is cached, so the frontend's later render
 * reuses it rather than re-reading.
 */
async function uiResourceIsReadable(params: {
  uri: string;
  agentId: string;
  tokenAuth?: TokenAuthContext;
}): Promise<boolean> {
  try {
    await mcpClient.readResource(params.uri, params.agentId, params.tokenAuth);
    return true;
  } catch (error) {
    logger.debug(
      { error, uri: params.uri, agentId: params.agentId },
      "MCP App UI resource unreadable; rendering as a plain tool call",
    );
    return false;
  }
}

// The resolved catalog tool nests its MCP `_meta` one level down under `meta`.
function toolProvidesUiResource(tool: CatalogTool): boolean {
  const meta = (
    tool.meta as
      | {
          _meta?: {
            ui?: { resourceUri?: unknown };
            "ui/resourceUri"?: unknown;
          };
        }
      | null
      | undefined
  )?._meta;
  return metaProvidesUiResource(meta);
}

async function buildUnsafeContextBoundaryResult(params: {
  resultMeta?: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  toolOutput: unknown;
  agentId: string;
  considerContextUntrusted: boolean;
}): Promise<{
  _meta?: Record<string, unknown>;
  unsafeContextBoundary?: UnsafeContextBoundary;
}> {
  // A platform dispatch error (tool_state, e.g. unknown_tool) never reached an
  // upstream tool, so its result is platform-authored text with no external
  // data — never mark the context unsafe for it. Mirrors the trusted-data bulk
  // re-evaluation, which exempts the same envelopes; without both, a benign
  // unresolved-tool error poisons the session and blocks the next legit call.
  if (
    extractMcpToolError({
      _meta: params.resultMeta,
      content: params.toolOutput,
    })?.type === "tool_state"
  ) {
    return params.resultMeta && Object.keys(params.resultMeta).length > 0
      ? { _meta: params.resultMeta }
      : {};
  }

  const unsafeContextBoundary =
    await evaluateUnsafeContextBoundaryForToolResult(params);
  const mergedMeta = unsafeContextBoundary
    ? {
        ...params.resultMeta,
        unsafeContextBoundary,
      }
    : params.resultMeta;

  return {
    ...(mergedMeta && Object.keys(mergedMeta).length > 0
      ? { _meta: mergedMeta }
      : {}),
    ...(unsafeContextBoundary ? { unsafeContextBoundary } : {}),
  };
}

async function evaluateUnsafeContextBoundaryForToolResult(params: {
  toolCallId: string;
  toolName: string;
  toolOutput: unknown;
  agentId: string;
  considerContextUntrusted: boolean;
}): Promise<UnsafeContextBoundary | undefined> {
  if (params.considerContextUntrusted) {
    return undefined;
  }

  const teamIds = await AgentTeamModel.getTeamsForAgent(params.agentId);
  const evaluation = await TrustedDataPolicyModel.evaluateBulk(
    params.agentId,
    [
      {
        toolName: params.toolName,
        toolOutput: params.toolOutput,
      },
    ],
    {
      teamIds,
      externalAgentId: getChatExternalAgentId(),
    },
  );

  const toolResultEvaluation = evaluation.get("0");
  const reason = !toolResultEvaluation
    ? UNSAFE_CONTEXT_BOUNDARY_REASON.toolResultMarkedUntrusted
    : toolResultEvaluation.isBlocked
      ? UNSAFE_CONTEXT_BOUNDARY_REASON.toolResultBlocked
      : toolResultEvaluation.isTrusted
        ? undefined
        : UNSAFE_CONTEXT_BOUNDARY_REASON.toolResultMarkedUntrusted;
  if (!reason) {
    return undefined;
  }

  return {
    kind: "tool_result",
    reason,
    toolCallId: params.toolCallId,
    toolName: params.toolName,
  };
}

function buildTokenAuthContext({
  mcpGwToken,
  organizationId,
  userId,
}: {
  mcpGwToken: McpGatewayToken | null;
  organizationId: string;
  userId: string;
}): TokenAuthContext | undefined {
  if (!mcpGwToken) {
    return undefined;
  }

  return {
    tokenId: mcpGwToken.tokenId,
    teamId: mcpGwToken.teamId,
    isOrganizationToken: mcpGwToken.isOrganizationToken,
    organizationId,
    isUserToken: mcpGwToken.isUserToken,
    userId: mcpGwToken.isUserToken ? userId : undefined,
  };
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (!abortSignal?.aborted) {
    return;
  }

  const abortError = new Error("Chat execution aborted");
  abortError.name = "AbortError";
  throw abortError;
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  return error.message.toLowerCase().includes("abort");
}

async function throwIfApprovalRequired(
  toolName: string,
  args: unknown,
): Promise<void> {
  const approvalTarget = resolveApprovalPolicyTarget(toolName, args);
  const requiresApproval =
    await ToolInvocationPolicyModel.checkApprovalRequired(
      approvalTarget.toolName,
      approvalTarget.toolInput,
      {
        teamIds: [],
        externalAgentId: getChatExternalAgentId(),
      },
    );
  if (requiresApproval) {
    throw new Error(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
  }
}

function resolveApprovalPolicyTarget(
  toolName: string,
  args: unknown,
): { toolName: string; toolInput: Record<string, unknown> } {
  return resolveRunToolTarget(toolName, args);
}

function reportToolMetrics(params: {
  toolName: string;
  agentId: string;
  agentName: string;
  startTime: number;
  isError: boolean;
}): void {
  const { serverName } = parseFullToolName(params.toolName);
  metrics.mcp.reportMcpToolCall({
    agentId: params.agentId,
    agentName: params.agentName,
    agentType: null,
    mcpServerName: serverName ?? "unknown",
    toolName: params.toolName,
    durationSeconds: (Date.now() - params.startTime) / 1000,
    isError: params.isError,
  });
}

/**
 * Context needed to fire the PreToolUse / PostToolUse lifecycle hooks against a
 * conversation's default sandbox. Hooks require a conversationId (the sandbox
 * session key) and the conversation's user id, so the caller passes both.
 */
interface ToolHookContext {
  agentId: string;
  organizationId: string;
  /** Conversation user id — the default sandbox is keyed per org/user/conversation. */
  userId: string;
  conversationId?: string;
  /**
   * Per-turn sink the chat route drains into inline `data-hook-run` entries.
   * Pre/PostToolUse runs are appended here, tagged with the tool call's id so
   * they render next to that tool call. Absent for non-chat callers.
   */
  hookRunCollector?: CollectedHookRun[];
}

/**
 * Fires the PreToolUse lifecycle hook before a tool executes. Returns a block
 * reason string when a hook blocks (the caller must NOT execute the tool and
 * should return a tool-result describing the block); returns null to proceed.
 * Cheap no-op when no conversation context or no hooks. Fails open on error.
 */
async function firePreToolUseHook(params: {
  ctx: ToolHookContext;
  toolName: string;
  toolInput: unknown;
  toolCallId?: string;
}): Promise<string | null> {
  const { ctx, toolName, toolInput, toolCallId } = params;
  if (!ctx.conversationId) {
    return null;
  }
  try {
    const result = await hookDispatcherService.fire({
      event: "pre_tool_use",
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      fields: { tool_name: toolName, tool_input: toolInput ?? {} },
    });
    // Record the run for inline display, anchored before this tool call.
    if (ctx.hookRunCollector && toolCallId) {
      ctx.hookRunCollector.push(
        ...toCollectedRuns(
          result.runs,
          { kind: "tool-pre", toolCallId },
          toolName,
        ),
      );
    }
    if (result.decision === "block") {
      return result.reason ?? null;
    }
  } catch (error) {
    logger.warn(
      { error, toolName, agentId: ctx.agentId },
      "PreToolUse hook dispatch failed, proceeding",
    );
  }
  return null;
}

/** Tool-result text returned to the model when a PreToolUse hook blocks a call. */
function buildPreToolUseBlockedResult(reason: string | null): string {
  return `Tool call blocked by a PreToolUse hook. Reason: ${reason ?? "no reason given"}. Do not retry; explain the block to the user.`;
}

/**
 * Tool-result text returned in place of executing a tool call that has repeated
 * with identical arguments past the threshold (see ToolCallRepeatTracker). The
 * call is not executed; this message replaces its result. At the termination
 * tier the run is also stopped (see repeatCeilingStopCondition), so this text is
 * the last recorded content and states why the run ended.
 */
function buildRepeatedCallNudge(
  toolName: string,
  count: number,
  severity: RepeatSeverity,
): string {
  if (severity === "terminate") {
    return `You have called \`${toolName}\` with identical arguments ${count} times in a row despite earlier nudges, so the run is being stopped — repeating it cannot produce a different result.`;
  }
  return `You have called \`${toolName}\` with identical arguments ${count} times in a row, so it was not executed again — repeating it will not produce a different result. Change the arguments, use a different tool, or give your best final answer with what you already know.`;
}

/**
 * Circuit breaker for repeated identical tool calls. Records the call on the
 * per-run tracker and, once the same (tool + args) repeats past the threshold,
 * returns the nudge text to use in place of executing the tool; returns null
 * below the threshold so the caller proceeds normally. A skip is reported as a
 * non-error tool call: nothing failed — the loop was just short-circuited — so
 * it must not inflate tool error metrics. Shared by the MCP and delegation
 * tool wrappers, which hold one tracker per run via ctx.
 */
function applyRepeatedCallBreaker(params: {
  ctx: ChatToolContext;
  toolName: string;
  toolArguments: Record<string, unknown> | undefined;
  span: Parameters<Parameters<typeof startActiveMcpSpan>[0]["callback"]>[0];
  startTime: number;
}): string | null {
  const { ctx, toolName, toolArguments, span, startTime } = params;
  const repeat = ctx.repeatTracker.record(toolName, toolArguments);
  if (!repeat.shouldNudge) {
    return null;
  }
  logger.warn(
    {
      agentId: ctx.agentId,
      conversationId: ctx.conversationId ?? null,
      sessionId: ctx.sessionId ?? null,
      toolName,
      count: repeat.count,
      severity: repeat.severity,
    },
    repeat.severity === "terminate"
      ? "Repeated identical tool call hit the ceiling; stopping the run"
      : "Skipping repeated identical tool call; nudging the model",
  );
  span.setAttribute(ATTR_MCP_IS_ERROR_RESULT, false);
  reportToolMetrics({
    toolName,
    agentId: ctx.agentId,
    agentName: ctx.agentName,
    startTime,
    isError: false,
  });
  return buildRepeatedCallNudge(toolName, repeat.count, repeat.severity);
}

/** Max chars of tool output passed to a PostToolUse hook payload. */
const POST_TOOL_USE_RESPONSE_CAP = 50_000;

/**
 * Fires the PostToolUse lifecycle hook after a tool executes. When a hook blocks
 * and supplies a reason, returns hook feedback to append to the tool result;
 * otherwise returns null (return the result unchanged). Cheap no-op without
 * conversation context or hooks. Fails open on error.
 */
async function firePostToolUseHook(params: {
  ctx: ToolHookContext;
  toolName: string;
  toolInput: unknown;
  toolResponse: string;
  toolCallId?: string;
}): Promise<string | null> {
  const { ctx, toolName, toolInput, toolResponse, toolCallId } = params;
  if (!ctx.conversationId) {
    return null;
  }
  try {
    const result = await hookDispatcherService.fire({
      event: "post_tool_use",
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      fields: {
        tool_name: toolName,
        tool_input: toolInput ?? {},
        tool_response: toolResponse.slice(0, POST_TOOL_USE_RESPONSE_CAP),
      },
    });
    // Record the run for inline display, anchored after this tool call.
    if (ctx.hookRunCollector && toolCallId) {
      ctx.hookRunCollector.push(
        ...toCollectedRuns(
          result.runs,
          { kind: "tool-post", toolCallId },
          toolName,
        ),
      );
    }
    // Phase 1: only a blocking hook's stderr becomes [hook feedback].
    // injectedContext (stdout on proceed) does not reach the model in this phase.
    if (result.decision === "block" && result.reason) {
      return result.reason;
    }
  } catch (error) {
    logger.warn(
      { error, toolName, agentId: ctx.agentId },
      "PostToolUse hook dispatch failed, proceeding",
    );
  }
  return null;
}

/**
 * Extracts the plain-text body of a tool-execution result for the PostToolUse
 * hook payload and for appending hook feedback. Tool results are either a plain
 * string or a rich `{ content }` object (see executeMcpTool / buildArchestraToolOutput).
 */
function toolResultText(
  result: string | { content: string; [key: string]: unknown },
): string {
  return typeof result === "string" ? result : result.content;
}

/**
 * Appends PostToolUse hook feedback to a tool result, preserving its shape: a
 * string stays a string; a rich `{ content }` object keeps its other fields.
 */
function appendHookFeedbackToToolResult<
  T extends string | { content: string; [key: string]: unknown },
>(result: T, feedback: string): T {
  const suffix = `\n\n[hook feedback] ${feedback}`;
  if (typeof result === "string") {
    return (result + suffix) as T;
  }
  const objectResult = result as { content: string; [key: string]: unknown };
  return {
    ...objectResult,
    content: objectResult.content + suffix,
  } as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and normalize JSON Schema for OpenAI
 */
function normalizeJsonSchema(schema: unknown): JSONSchema7 {
  const fallbackSchema: JSONSchema7 = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  if (!isRecord(schema)) {
    return fallbackSchema;
  }

  const schemaType = schema.type;
  if (typeof schemaType !== "string") {
    return fallbackSchema;
  }

  if (schemaType === "None" || schemaType === "null") {
    return fallbackSchema;
  }

  // Give every subschema an explicit `type`. MCP servers may emit untyped
  // nodes (e.g. zod `z.unknown()` becomes a bare `{}`), which are valid JSON
  // Schema but rejected by providers with strict function-call validation —
  // Gemini/Vertex 400s with "schema didn't specify the schema type field",
  // and that can surface even behind OpenRouter when it routes a model to a
  // Google-hosted deployment.
  const typed = ensureExplicitSchemaTypes(schema);

  // Add additionalProperties: false to all object-type schemas recursively.
  // This is required for OpenAI-compatible providers (Ollama, vLLM) to properly
  // emit streaming tool calls instead of outputting tool calls as text content.
  // Without it, models hallucinate extra properties and providers may fail to
  // recognize the output as a tool call in streaming mode.
  return addAdditionalPropertiesFalse(typed) as JSONSchema7;
}

// JSON-schema keywords whose value is a map of named subschemas
const SUBSCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
] as const;

// JSON-schema keywords whose value is an array of subschemas
const SUBSCHEMA_ARRAY_KEYS = [
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
] as const;

// JSON-schema keywords whose value is a single subschema
const SINGLE_SUBSCHEMA_KEYS = [
  "additionalProperties",
  "items",
  "contains",
  "not",
] as const;

/**
 * Recursively ensures every schema node carries an explicit `type` (or is a
 * `$ref` / an `anyOf`/`oneOf`/`allOf` composite whose branches are typed).
 * The type is inferred from structural keywords when possible; a completely
 * bare "accept anything" node (`{}`) becomes an open object — the same
 * fallback Google's own SDKs and LiteLLM apply for Vertex compatibility.
 */
function ensureExplicitSchemaTypes(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };

  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = result[key];
    if (isRecord(map)) {
      const newMap: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(map)) {
        newMap[name] = isRecord(sub) ? ensureExplicitSchemaTypes(sub) : sub;
      }
      result[key] = newMap;
    }
  }

  for (const key of SUBSCHEMA_ARRAY_KEYS) {
    const arr = result[key];
    if (Array.isArray(arr)) {
      result[key] = arr.map((sub) =>
        isRecord(sub) ? ensureExplicitSchemaTypes(sub) : sub,
      );
    }
  }

  for (const key of SINGLE_SUBSCHEMA_KEYS) {
    const sub = result[key];
    if (isRecord(sub)) {
      result[key] = ensureExplicitSchemaTypes(sub);
    }
  }

  // `items` may also be the (deprecated) tuple form
  if (Array.isArray(result.items)) {
    result.items = result.items.map((sub) =>
      isRecord(sub) ? ensureExplicitSchemaTypes(sub) : sub,
    );
  }

  if (result.type !== undefined || typeof result.$ref === "string") {
    return result;
  }
  // Composite nodes are typed via their branches
  if (
    Array.isArray(result.anyOf) ||
    Array.isArray(result.oneOf) ||
    Array.isArray(result.allOf)
  ) {
    return result;
  }

  const inferred = inferSchemaType(result);
  if (inferred) {
    result.type = inferred;
    return result;
  }

  // Bare "any" node: default to an open object. `additionalProperties: true`
  // is set explicitly so addAdditionalPropertiesFalse doesn't clamp it shut.
  result.type = "object";
  result.additionalProperties = true;
  return result;
}

/** Infers a JSON-schema `type` from structural keywords, or null for a bare node. */
function inferSchemaType(node: Record<string, unknown>): string | null {
  if (
    isRecord(node.properties) ||
    isRecord(node.patternProperties) ||
    Array.isArray(node.required) ||
    "additionalProperties" in node
  ) {
    return "object";
  }
  if ("items" in node || "prefixItems" in node || "contains" in node) {
    return "array";
  }
  const literals = Array.isArray(node.enum)
    ? node.enum
    : "const" in node
      ? [node.const]
      : [];
  const nonNull = literals.filter((v) => v !== null);
  if (nonNull.length > 0) {
    if (nonNull.every((v) => typeof v === "string")) return "string";
    if (nonNull.every((v) => typeof v === "boolean")) return "boolean";
    if (nonNull.every((v) => typeof v === "number")) {
      return nonNull.every((v) => Number.isInteger(v)) ? "integer" : "number";
    }
  }
  return null;
}

/**
 * Recursively adds `additionalProperties: false` to all object-type schemas.
 * Traverses properties, array items, and nested schemas.
 */
function addAdditionalPropertiesFalse(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };

  if (result.type === "object") {
    if (!("additionalProperties" in result)) {
      result.additionalProperties = false;
    }

    if (isRecord(result.properties)) {
      const newProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result.properties)) {
        newProps[key] = isRecord(value)
          ? addAdditionalPropertiesFalse(value)
          : value;
      }
      result.properties = newProps;
    }
  }

  if (result.type === "array" && isRecord(result.items)) {
    result.items = addAdditionalPropertiesFalse(result.items);
  }

  return result;
}
