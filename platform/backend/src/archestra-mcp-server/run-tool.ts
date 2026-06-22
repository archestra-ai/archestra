import {
  ARCHESTRA_TOOL_SHORT_NAMES,
  type ArchestraToolShortName,
  getArchestraToolFullName,
  isAgentTool,
  TOOL_RUN_TOOL_SHORT_NAME,
} from "@archestra/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { evaluateSingleMcpToolInvocationPolicy } from "@/guardrails/tool-invocation";
import logger from "@/logging";
import { ConversationEnabledToolModel, ToolModel } from "@/models";
import { agentOwner, type Tool } from "@/types";
import { archestraMcpBranding } from "./branding";
import { isToolEnabledForConversation } from "./conversation-tool-filter";
import {
  dynamicAccessContext,
  getUnassignedDiscoverableTools,
  resolveDynamicTool,
  resolveRunToolTargetName,
} from "./dynamic-tools";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
} from "./helpers";
import { filterToolNamesByPermission } from "./rbac";
import {
  ambiguousShortNameMessage,
  recoveredShortNameNotice,
  toolNotEnabledForConversationMessage,
  unavailableThirdPartyToolMessage,
} from "./tool-recovery-messages";
import type { ArchestraContext } from "./types";

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
        "Arguments object for the target tool; must match its input schema.",
      ),
  })
  .strict();

type RunToolArgs = z.infer<typeof RunToolArgsSchema>;

const ARCHESTRA_SHORT_NAME_SET = new Set<string>(ARCHESTRA_TOOL_SHORT_NAMES);
const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_RUN_TOOL_SHORT_NAME,
    title: "Run Tool",
    description: `Dispatch to any tool available to this agent, including built-in platform tools, agent delegation tools ('agent-<id>'), or third-party MCP tools exposed through the MCP Gateway (e.g. 'context7__resolve-library-id'). When the agent allows dynamic tool access, a tool the user can access but the agent does not have runs directly without being assigned to the agent; the MCP server's connection policy decides which credential the call uses. Target-tool RBAC, invocation policies, argument validation, and output validation all still apply.`,
    schema: RunToolArgsSchema,
    handler: ({ args, context }) => runToolHandler({ args, context }),
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// ===== Internal helpers =====

/**
 * run_tool entry point. Recovers a short name to its exact `server__tool` form
 * before dispatch: an unambiguous match is dispatched with a soft recovery
 * notice prepended to the result; an ambiguous one is refused with the candidate
 * list so the model picks the exact name. The canonical form remains the exact
 * full name — short names are an implicit fallback only.
 */
async function runToolHandler({
  args,
  context,
}: {
  args: RunToolArgs;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const requestedName = args.tool_name;
  const recovery = await resolveShortName({ requestedName, context });
  if (recovery.kind === "ambiguous") {
    return errorResult(
      ambiguousShortNameMessage(requestedName, recovery.candidates),
    );
  }

  // Built-in recovery keeps the original short name as the effective name:
  // dispatch's existing `isArchestraShortName` path + resolveRunToolTargetName
  // already canonicalize it, so recovery only adds the notice. Third-party
  // recovery substitutes the resolved full name so dispatch routes to it.
  const effectiveName =
    recovery.kind === "thirdparty" ? recovery.fullName : requestedName;
  const result = await dispatchTool({
    requestedName,
    effectiveName,
    args,
    context,
  });

  // The notice only leads a successful recovered dispatch — an error result is
  // itself a corrective message (unknown/disabled tool, self-invocation, schema)
  // and must not be buried under the short-name hint.
  if (recovery.kind === "none" || result.isError) {
    return result;
  }
  const fullName =
    recovery.kind === "thirdparty" ? recovery.fullName : recovery.displayName;
  return prependRecoveryNotice(
    result,
    recoveredShortNameNotice(requestedName, fullName),
  );
}

type ShortNameResolution =
  | { kind: "none" }
  | { kind: "builtin"; displayName: string }
  | { kind: "thirdparty"; fullName: string }
  | { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve a requested run_tool name that omits the canonical `server__tool`
 * prefix. Names already in canonical form (containing `__`) and `agent-<id>`
 * delegations are taken as-is (`none`). A built-in short name is a reserved
 * namespace and wins unconditionally (`builtin`) — downstream RBAC/assignment in
 * executeArchestraTool still gates whether it runs. Otherwise the bare name is
 * matched against the suffix of the tools available to the agent, narrowed to
 * the same space search_tools shows (see `visibleCandidates`): exactly one match
 * recovers it (`thirdparty`), several is `ambiguous`, none is `none`.
 */
async function resolveShortName({
  requestedName,
  context,
}: {
  requestedName: string;
  context: ArchestraContext;
}): Promise<ShortNameResolution> {
  if (requestedName.includes("__") || isAgentTool(requestedName)) {
    return { kind: "none" };
  }
  if (ARCHESTRA_SHORT_NAME_SET.has(requestedName)) {
    return {
      kind: "builtin",
      displayName: archestraMcpBranding.getToolName(
        requestedName as ArchestraToolShortName,
      ),
    };
  }
  if (!context.agentId) {
    return { kind: "none" };
  }
  const candidates = await visibleCandidates({
    suffix: `__${requestedName}`,
    agentId: context.agentId,
    context,
  });
  if (candidates.length === 0) {
    return { kind: "none" };
  }
  if (candidates.length === 1) {
    return { kind: "thirdparty", fullName: candidates[0] };
  }
  return { kind: "ambiguous", candidates: candidates.sort() };
}

/**
 * Tool names ending in `suffix` that the agent can actually reach in this
 * context — its assigned tools plus, when dynamic access is on, the discoverable
 * set, then narrowed by the same gates search_tools applies: RBAC
 * (filterToolNamesByPermission) and the per-conversation tool selection. Without
 * that narrowing, recovery could resolve to — or an ambiguity message could
 * disclose — a tool the agent cannot discover here. Only consulted on the
 * recovery path (a bare, non-built-in name), never for an exact name.
 */
async function visibleCandidates(params: {
  suffix: string;
  agentId: string;
  context: ArchestraContext;
}): Promise<string[]> {
  const { agentId, context, suffix } = params;
  const accessParams = {
    agentId,
    userId: context.userId,
    organizationId: context.organizationId,
  };
  const assigned = await ToolModel.getMcpToolsByAgent(agentId);
  const names = assigned.map((tool) => tool.name);
  if (await dynamicAccessContext(accessParams)) {
    const discoverable = await getUnassignedDiscoverableTools({
      ...accessParams,
      assignedToolNames: new Set(names),
    });
    names.push(...discoverable.map((tool) => tool.name));
  }

  // `agent__<short>` proxy-discovered delegation artifacts are hidden from
  // search_tools, so a bare short name must not surface them here either.
  const matches = [
    ...new Set(
      names.filter(
        (name) => name.endsWith(suffix) && !name.startsWith("agent__"),
      ),
    ),
  ];
  if (matches.length === 0) {
    return matches;
  }
  const permitted = await filterToolNamesByPermission(
    matches,
    context.userId,
    context.organizationId,
  );
  const allowed = matches.filter((name) => permitted.has(name));
  if (allowed.length === 0 || !context.conversationId) {
    return allowed;
  }
  const enabledNames = await ConversationEnabledToolModel.getEnabledToolNameSet(
    context.conversationId,
  );
  return allowed.filter((name) =>
    isToolEnabledForConversation(name, enabledNames),
  );
}

function prependRecoveryNotice(
  result: CallToolResult,
  notice: string,
): CallToolResult {
  return {
    ...result,
    content: [{ type: "text", text: notice }, ...result.content],
  };
}

async function dispatchTool({
  requestedName,
  effectiveName,
  args,
  context,
}: {
  requestedName: string;
  effectiveName: string;
  args: RunToolArgs;
  context: ArchestraContext;
}): Promise<CallToolResult> {
  const isArchestraPrefixed = archestraMcpBranding.isToolName(effectiveName);
  const isAgentDelegation = isAgentTool(effectiveName);
  const isArchestraShortName = ARCHESTRA_SHORT_NAME_SET.has(effectiveName);

  const route: "archestra" | "third-party" =
    isArchestraPrefixed || isAgentDelegation || isArchestraShortName
      ? "archestra"
      : "third-party";

  const resolvedName = resolveRunToolTargetName(effectiveName);

  logger.info(
    {
      agentId: context.agentId,
      requestedName,
      resolvedName,
      route,
    },
    `${TOOL_RUN_TOOL_SHORT_NAME} dispatching`,
  );

  const runToolFullName = getArchestraToolFullName(TOOL_RUN_TOOL_SHORT_NAME);
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

  // Gate dispatch on the assigned-tool set, then fall back to dynamic
  // access: when the agent's "access all tools" setting is on, a tool the
  // user can access runs directly with call-time credential resolution —
  // nothing is written to the agent. A miss on both means the tool does
  // not exist for this user: steer the model at search_tools. The set is
  // reused by the policy gate below so it is fetched only once.
  const assignedTools = await ToolModel.getMcpToolsByAgent(context.agentId);
  const assignedToolNames = new Set(assignedTools.map((tool) => tool.name));
  let availableTool: Tool | null = null;
  if (!assignedToolNames.has(resolvedName)) {
    // A custom per-conversation tool selection is an allowlist over the
    // agent's assigned tools, so an unassigned tool can never be enabled in
    // it — return the same unavailable recovery search_tools shows.
    if (await checkConversationGate(resolvedName)) {
      return errorResult(unavailableThirdPartyToolMessage(resolvedName));
    }
    availableTool = await resolveDynamicTool({
      toolName: resolvedName,
      agentId: context.agentId,
      userId: context.userId,
      organizationId: context.organizationId,
    });
    logger.info(
      {
        agentId: context.agentId,
        requestedName,
        resolvedName,
        dynamicallyResolved: availableTool != null,
      },
      `${TOOL_RUN_TOOL_SHORT_NAME} dispatched to an unassigned tool`,
    );
    if (!availableTool) {
      return errorResult(unavailableThirdPartyToolMessage(resolvedName));
    }
  } else {
    // The tool is assigned — enforce the per-conversation selection.
    const gateError = await checkConversationGate(resolvedName);
    if (gateError) return gateError;
  }

  const toolInput = args.tool_args ?? {};
  // Reuse the set computed above so the policy gate does not re-query it.
  // A dynamically resolved tool is appended so the evaluator does not
  // refuse it as "disabled" — invocation policies still evaluate it.
  const policyBlock = await evaluateSingleMcpToolInvocationPolicy({
    agentId: context.agentId,
    toolName: resolvedName,
    toolInput,
    organizationId: context.organizationId,
    contextIsTrusted: context.contextIsTrusted ?? true,
    enforceApprovalRequired: !context.approvalRequiredPoliciesHandled,
    enabledToolNames: availableTool
      ? new Set([...assignedToolNames, resolvedName])
      : assignedToolNames,
  });
  if (policyBlock) {
    return errorResult(policyBlock.refusalMessage);
  }

  // Cheap structural pre-check against the target's stored schema. Runs only
  // after access + invocation policy passed, and never dispatches a call we
  // can prove malformed (a "send"/"create" tool would still act on partial
  // args). On failure the model gets the full schema — the targeted feedback
  // the compact search_tools signature defers to. Deliberately shallow: only
  // a literal top-level `required` and a closed `additionalProperties:false`
  // are enforced, so refs/composed schemas fall through to the upstream
  // server unchanged.
  // Dynamic dispatch passes availableTool straight through, so its schema is
  // exactly what runs. For the assigned path the gateway re-resolves by name
  // at dispatch with no defined ordering, so when duplicate rows share the
  // name we cannot know which schema will run — skip the pre-check rather
  // than risk validating against the wrong row.
  const assignedMatches = assignedTools.filter(
    (tool) => tool.name === resolvedName,
  );
  const targetSchema = availableTool
    ? availableTool.parameters
    : assignedMatches.length === 1
      ? assignedMatches[0].parameters
      : undefined;
  const schemaError = checkThirdPartyToolArgs({
    toolName: resolvedName,
    toolArgs: toolInput,
    schema: targetSchema,
  });
  if (schemaError) {
    return schemaError;
  }

  const { default: mcpClient } = await import("@/clients/mcp-client");
  const toolCallId = `run-tool-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  const result = await mcpClient.executeToolCallForOwner(
    {
      id: toolCallId,
      name: resolvedName,
      arguments: toolInput,
    },
    agentOwner(context.agentId),
    context.tokenAuth,
    // mcp-client scopes per-conversation sessions (e.g. browser contexts)
    // by this key; headless executions use their isolation key so
    // concurrent runs never share a session and cleanup can close it.
    // availableTool lets a tool the agent has no assignment for execute in
    // "All tools" mode; it is only ever set after the dynamic-access gates
    // above passed, and the MCP server's connection policy still decides
    // which credential the call uses.
    {
      conversationId: context.isolationKey ?? context.conversationId,
      availableTool: availableTool ?? undefined,
    },
  );

  return {
    content: Array.isArray(result.content)
      ? (result.content as CallToolResult["content"])
      : [{ type: "text", text: JSON.stringify(result.content) }],
    isError: result.isError,
    _meta: result._meta,
    structuredContent: result.structuredContent as
      | Record<string, unknown>
      | undefined,
  };
}

/**
 * Shallow structural validation of a third-party tool's `tool_args` against its
 * stored JSON schema. Returns a schema-bearing error result when the call is
 * provably malformed, else null. Intentionally minimal — no JSON Schema engine:
 *  - rejects a missing key named in a literal top-level `required: string[]`;
 *  - rejects an unknown top-level key only when the schema literally sets
 *    `additionalProperties: false` and exposes a literal top-level `properties`.
 * Anything else (`$ref`, `allOf`, types, enums, nested constraints) is left to
 * the upstream MCP server, so a schema shape we cannot read never blocks a call.
 */
function checkThirdPartyToolArgs(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  schema: unknown;
}): CallToolResult | null {
  const { schema, toolArgs, toolName } = params;
  if (!isRecord(schema)) {
    return null;
  }

  const problems: string[] = [];

  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  for (const key of required) {
    if (!(key in toolArgs)) {
      problems.push(`missing required parameter "${key}"`);
    }
  }

  // Unknown-key check only when the schema is literally closed and names its
  // keys via `properties`. `patternProperties` also admits keys, so its presence
  // disables this branch to avoid rejecting a key it would have matched.
  const properties = isRecord(schema.properties) ? schema.properties : null;
  const hasPatternProperties =
    isRecord(schema.patternProperties) &&
    Object.keys(schema.patternProperties).length > 0;
  if (
    schema.additionalProperties === false &&
    properties &&
    !hasPatternProperties
  ) {
    for (const key of Object.keys(toolArgs)) {
      if (!(key in properties)) {
        problems.push(`unexpected parameter "${key}"`);
      }
    }
  }

  if (problems.length === 0) {
    return null;
  }

  const skeletonEntries = required.map(
    (key) =>
      `${JSON.stringify(key)}: ${placeholderForSchema(properties?.[key], 1)}`,
  );
  const sentCall = safeJsonStringify({
    tool_name: toolName,
    tool_args: toolArgs,
  });
  const messageLines = [
    `Invalid tool_args for "${toolName}": ${problems.join("; ")}.`,
    "Put each of the target tool's parameters inside tool_args.",
    `You sent: ${sentCall}`,
  ];
  if (skeletonEntries.length > 0) {
    messageLines.push(
      `Send instead: {"tool_name": ${JSON.stringify(toolName)}, "tool_args": {${skeletonEntries.join(", ")}}} ` +
        "(replace each <…> with a real value).",
    );
  }
  messageLines.push(
    `The tool's full input schema is:\n${safeJsonStringify(schema, 2)}`,
  );
  return errorResult(messageLines.join("\n"));
}

/**
 * JSON.stringify that never throws — the diagnostic path serializes
 * model-supplied tool_args and a catalog schema, either of which could carry a
 * BigInt or a circular reference. A failure must not turn a validation error
 * into an exception, so fall back to an opaque marker.
 */
function safeJsonStringify(value: unknown, indent?: number): string {
  try {
    return (
      JSON.stringify(
        value,
        (_key, v) => (typeof v === "bigint" ? v.toString() : v),
        indent,
      ) ?? "<unserializable>"
    );
  } catch {
    return "<unserializable>";
  }
}

/** How many levels of object/array nesting a skeleton unpacks before falling
 * back to an opaque tag. Generous: this runs only on an already-failed call, so
 * a fuller skeleton beats a terser one — the cap is just a guard against a
 * pathologically deep schema (`$ref` cycles already bail above). */
const MAX_SKELETON_DEPTH = 8;

/**
 * Illustrative placeholder for a value, derived from its declared JSON Schema.
 * Prefers a concrete literal (`const`, first `enum` member); otherwise reads
 * only literal `properties`/`required`/`items` (mirroring the shallow validation)
 * and recurses into object/array shapes up to MAX_SKELETON_DEPTH. A `type` array
 * (e.g. `["string","null"]`) resolves to its first non-null member. Falls back to
 * an opaque type tag for free-form objects, `$ref`/`allOf`/`oneOf`/`anyOf`, or
 * past the depth cap — the full schema appended to the error carries the rest.
 */
function placeholderForSchema(schema: unknown, depth: number): string {
  if (!isRecord(schema)) {
    return "<value>";
  }
  if ("const" in schema) {
    return safeJsonStringify(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return safeJsonStringify(schema.enum[0]);
  }
  if (
    "$ref" in schema ||
    "allOf" in schema ||
    "oneOf" in schema ||
    "anyOf" in schema
  ) {
    return "<value>";
  }
  const types = Array.isArray(schema.type)
    ? schema.type.filter((t): t is string => typeof t === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : [];
  const primaryType = types.find((t) => t !== "null") ?? types[0];
  switch (primaryType) {
    case "string":
      return "<string>";
    case "number":
    case "integer":
      return "<number>";
    case "boolean":
      return "<boolean>";
    case "null":
      return "null";
    case "array": {
      if (depth < MAX_SKELETON_DEPTH && isRecord(schema.items)) {
        return `[${placeholderForSchema(schema.items, depth + 1)}]`;
      }
      return "<array>";
    }
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : null;
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (key): key is string => typeof key === "string",
          )
        : [];
      if (depth < MAX_SKELETON_DEPTH && properties && required.length > 0) {
        const entries = required.map(
          (key) =>
            `${JSON.stringify(key)}: ${placeholderForSchema(properties[key], depth + 1)}`,
        );
        return `{${entries.join(", ")}}`;
      }
      return "<object>";
    }
    default:
      return "<value>";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
