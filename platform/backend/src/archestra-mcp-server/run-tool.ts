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
import { buildPolicyBlockedToolResult } from "@/guardrails/tool-policy-link";
import logger from "@/logging";
import { ConversationEnabledToolModel } from "@/models";
import { agentToolExclusionsService } from "@/services/agent-tool-exclusions";
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
  structuredToolErrorResult,
} from "./helpers";
import { filterToolNamesByPermission } from "./rbac";
import { placeholderForSchema, safeJsonStringify } from "./tool-args-skeleton";
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
    description: `Dispatch to any tool available to this agent, including built-in platform tools, agent delegation tools ('agent-<id>'), or third-party MCP tools exposed through the MCP Gateway (e.g. 'context7__resolve-library-id'). When the agent allows dynamic tool access, a tool the user can access but the agent does not have runs directly without being assigned to the agent; the MCP server's connection policy decides which credential the call uses. Target-tool RBAC, invocation policies, argument validation, and output validation all still apply. The app-authoring tools, when available to this agent, are reached this way too: when asked to make, build, or create an interactive app, start with 'scaffold_app' through this tool instead of writing app code in a reply (an unavailable tool is refused with a clear error).`,
    schema: RunToolArgsSchema,
    handler: ({ args, context }) => runToolHandler({ args, context }),
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

/** @public — exported for testability */
export const __test = {
  repairEnvelopedToolArgs,
};

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
  // Per-agent exclusions (Auto-tool mode): an excluded tool must not be
  // recovered from a short name, nor disclosed as a "did you mean" candidate.
  // Loaded once and applied to the assigned + discoverable contributions.
  const { tools: assigned, exclusionSets } =
    await agentToolExclusionsService.getFilteredMcpToolsByAgent(agentId);
  const names = assigned.map((tool) => tool.name);
  if (await dynamicAccessContext(accessParams)) {
    const discoverable = await getUnassignedDiscoverableTools({
      ...accessParams,
      assignedToolNames: new Set(names),
      exclusionSets,
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
    return errorResult(
      `${TOOL_RUN_TOOL_SHORT_NAME} cannot invoke itself. Call ${TOOL_RUN_TOOL_SHORT_NAME} once, with tool_name set to the target tool's exact name (from search_tools) and the target's arguments in tool_args — never set tool_name to ${TOOL_RUN_TOOL_SHORT_NAME}.`,
    );
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
    const { executeArchestraTool, getArchestraToolInputSchema } = await import(
      "./index"
    );
    // Envelope repair against the built-in's published input schema, so the
    // handler's strict zod validation sees the repaired args. Delegations
    // (agent-<id>) have no published JSON schema — the lookup returns
    // undefined and nothing is repaired.
    const { repairedParams, toolArgs } = repairEnvelopedToolArgs({
      toolArgs: args.tool_args ?? {},
      schema: getArchestraToolInputSchema(resolvedName),
    });
    const result = await executeArchestraTool(resolvedName, toolArgs, context);
    // Only disclose the repair once the call has cleared the RBAC/assignment
    // gates inside executeArchestraTool — those run before arg validation and
    // reject with a plain error carrying no archestraValidation descriptor. A
    // success or a post-gate validation error (which does carry it) is safe to
    // annotate; a gate denial is not, or the note would leak a denied caller
    // the declared type of a param they cannot reach.
    return reachedArgValidation(result)
      ? appendEnvelopeRepairNote(result, repairedParams)
      : result;
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
  // Per-agent exclusions (Auto-tool mode, loaded once per dispatch): an
  // assigned-but-excluded tool drops out of the assigned set here and the
  // dynamic fallback refuses it too, so it resolves to "unavailable".
  const { tools: assignedTools, exclusionSets } =
    await agentToolExclusionsService.getFilteredMcpToolsByAgent(
      context.agentId,
    );
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
      exclusionSets,
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

  // The target's stored input schema, resolved BEFORE the policy gate so the
  // envelope repair below runs first and invocation policy evaluation, the
  // shallow pre-check, and dispatch all see the same repaired tool_args.
  // Dynamic dispatch passes availableTool straight through, so its schema is
  // exactly what runs. For the assigned path the gateway re-resolves by name
  // at dispatch with no defined ordering, so when duplicate rows share the
  // name we cannot know which schema will run — treat it as unknown rather
  // than risk reading the wrong row.
  const assignedMatches = assignedTools.filter(
    (tool) => tool.name === resolvedName,
  );
  const targetSchema = availableTool
    ? availableTool.parameters
    : assignedMatches.length === 1
      ? assignedMatches[0].parameters
      : undefined;

  // Schema-aware envelope repair: unwrap single-key wrapper objects (any key)
  // and the two-key {type:"text",text} content block around params the schema
  // declares scalar/array (see repairEnvelopedToolArgs). Disclosed via a note
  // appended to the result.
  const { repairedParams, toolArgs: toolInput } = repairEnvelopedToolArgs({
    toolArgs: args.tool_args ?? {},
    schema: targetSchema,
  });

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
    // The dynamically-resolved All-mode row that will execute. The assigned case
    // is resolved centrally via the execution resolver, so only the dynamic id
    // is passed here. The id rides along on a block for the "Edit policy" modal
    // (All-mode tools have no agent_tools row for the modal's lookup to find).
    resolvedToolId: availableTool?.id,
  });
  if (policyBlock) {
    // Attach the structured policy_denied error (in _meta + structuredContent)
    // so clients parse the block without scraping the prose. A caller who can
    // edit guardrails also gets a deep link to this tool's policy editor.
    const { error, text } = await buildPolicyBlockedToolResult({
      policyBlock,
      userId: context.userId,
      organizationId: context.organizationId,
      textPrefix: "Error: ",
    });
    return appendEnvelopeRepairNote(
      structuredToolErrorResult({ error, text }),
      repairedParams,
    );
  }

  // Cheap structural pre-check against the target's stored schema. Runs only
  // after access + invocation policy passed, and never dispatches a call we
  // can prove malformed (a "send"/"create" tool would still act on partial
  // args). On failure the model gets the full schema — the targeted feedback
  // the compact search_tools signature defers to. Deliberately shallow: only
  // a literal top-level `required` and a closed `additionalProperties:false`
  // are enforced, so refs/composed schemas fall through to the upstream
  // server unchanged. Runs on the repaired tool_args against the same schema
  // resolved above (undefined when duplicate rows share the name — skip the
  // pre-check rather than risk validating against the wrong row).
  const schemaError = checkThirdPartyToolArgs({
    toolName: resolvedName,
    toolArgs: toolInput,
    schema: targetSchema,
  });
  if (schemaError) {
    return appendEnvelopeRepairNote(schemaError, repairedParams);
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
    // "Auto" mode; it is only ever set after the dynamic-access gates
    // above passed, and the MCP server's connection policy still decides
    // which credential the call uses.
    {
      conversationId: context.isolationKey ?? context.conversationId,
      availableTool: availableTool ?? undefined,
      // Cancel the in-flight upstream call when the chat run is stopped.
      abortSignal: context.abortSignal,
    },
  );

  return appendEnvelopeRepairNote(
    {
      content: Array.isArray(result.content)
        ? (result.content as CallToolResult["content"])
        : [{ type: "text", text: JSON.stringify(result.content) }],
      isError: result.isError,
      _meta: stripArchestraValidationMeta(result._meta),
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    },
    repairedParams,
  );
}

/**
 * `_meta.archestraValidation` is this platform's own validation descriptor
 * (index.ts); an upstream third-party server must not be able to forge it and
 * pass `reachedArgValidation`, unlocking the repair-note disclosure. Other
 * `_meta` keys pass through untouched.
 */
function stripArchestraValidationMeta(
  meta: CallToolResult["_meta"],
): CallToolResult["_meta"] {
  if (!isRecord(meta) || !("archestraValidation" in meta)) {
    return meta;
  }
  const { archestraValidation: _dropped, ...rest } = meta;
  return rest;
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

/** Param types the repair may unwrap to — a literal declared `type` only. */
type RepairableDeclaredType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array";

/**
 * Deterministic repair for the wrapper anti-patterns weak models produce when
 * calling run_tool: a scalar/array param wrapped in a single-key object — the key
 * can be anything, from a known envelope word (`{"value": …}`, `{"$text": …}`) to
 * the param's own name (`{"appId": {"appId": …}}`) to an arbitrary string the
 * model fixates on (`{"my-app": "my-app"}`) — or as the Anthropic text content
 * block `{"type":"text","text": …}` (exactly two keys) leaked from message content.
 * A top-level tool_args entry is unwrapped only when ALL hold:
 *  - the tool's schema literally declares the param's `type` as
 *    string/number/integer/boolean/array (no type arrays, no
 *    $ref/anyOf/oneOf/allOf composition);
 *  - the supplied value is a plain object of a recognized wrapper shape (see
 *    envelopeInnerValue);
 *  - the inner value already matches the declared type (see
 *    innerMatchesDeclaredType) — the repair never retypes a value.
 * The guard is on the declared *type* only — it deliberately does not check
 * `enum`/`const`/`items`/tuple/`additionalProperties`; the target tool applies its
 * complete schema at dispatch, so an inner value that satisfies the type but
 * violates a non-type constraint is rejected downstream exactly as the wrapper
 * object would be. The unwrapped value is the model's own inner value, never a
 * fabricated one, so repair delivers the model's intended `param = X` call. Under
 * those conditions the as-sent value (an object) is provably invalid against the
 * declared scalar/array type, so the repair can never rewrite a call the schema
 * could accept. Anything else — object-typed params, loose/absent types,
 * unrecognized multi-key objects — is left untouched, and a call with nothing to
 * repair passes through as the same object.
 */
function repairEnvelopedToolArgs(params: {
  toolArgs: Record<string, unknown>;
  schema: unknown;
}): { toolArgs: Record<string, unknown>; repairedParams: string[] } {
  const { schema, toolArgs } = params;
  const properties =
    isRecord(schema) && isRecord(schema.properties) ? schema.properties : null;
  if (!properties) {
    return { toolArgs, repairedParams: [] };
  }

  const repairedParams: string[] = [];
  const repaired: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolArgs)) {
    const unwrapped = unwrapEnvelope({
      value,
      propertySchema: properties[key],
    });
    if (unwrapped) {
      repairedParams.push(key);
      repaired[key] = unwrapped.inner;
    } else {
      repaired[key] = value;
    }
  }
  return repairedParams.length === 0
    ? { toolArgs, repairedParams }
    : { toolArgs: repaired, repairedParams };
}

/** The unwrapped inner value, or null when the entry does not qualify. */
function unwrapEnvelope(params: {
  value: unknown;
  propertySchema: unknown;
}): { inner: unknown } | null {
  const { propertySchema, value } = params;
  if (!isRecord(value)) {
    return null;
  }
  const candidate = envelopeInnerValue(value);
  if (!candidate) {
    return null;
  }

  if (!isRecord(propertySchema)) {
    return null;
  }
  // A composed/referenced schema may accept the object as sent — never touch it.
  if (
    "$ref" in propertySchema ||
    "anyOf" in propertySchema ||
    "oneOf" in propertySchema ||
    "allOf" in propertySchema
  ) {
    return null;
  }
  const declaredType = asRepairableDeclaredType(propertySchema.type);
  if (!declaredType) {
    return null;
  }

  return innerMatchesDeclaredType(candidate.inner, declaredType);
}

/**
 * The inner value from a recognized wrapper shape, or null when `value` is not
 * a wrapper. Two shapes qualify:
 *  - single-key wrapper: any object with exactly one key — its sole value is the
 *    candidate, whatever the key is named (`{"value": X}`, `{"appId": X}`,
 *    `{"my-app": X}`). The key name carries no meaning; weak models wrap under an
 *    arbitrary string, so an allow-list would miss the common cases.
 *  - Anthropic text content block: exactly the two keys `{type, text}` with
 *    `type === "text"` — e.g. `{"type":"text","text":X}`, the shape weak models
 *    leak from message content into tool_args.
 * The caller enforces the declared-type guards; either shape is an object and so
 * is provably invalid against a scalar/array declared type, keeping the repair
 * unable to rewrite a call the schema would have accepted.
 */
function envelopeInnerValue(
  value: Record<string, unknown>,
): { inner: unknown } | null {
  const keys = Object.keys(value);
  if (keys.length === 1) {
    return { inner: value[keys[0]] };
  }
  if (keys.length === 2 && value.type === "text" && "text" in value) {
    return { inner: value.text };
  }
  return null;
}

function asRepairableDeclaredType(
  value: unknown,
): RepairableDeclaredType | null {
  switch (value) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "array":
      return value;
    default:
      return null;
  }
}

/**
 * Whether the inner value already matches the declared scalar/array type. The
 * repair delivers the model's own value untouched and never retypes it: a
 * number carried as a string stays wrapped, fails the target's validation, and
 * the validation error's parameter skeleton teaches the shape.
 */
function innerMatchesDeclaredType(
  value: unknown,
  declaredType: RepairableDeclaredType,
): { inner: unknown } | null {
  switch (declaredType) {
    case "string":
      return typeof value === "string" ? { inner: value } : null;
    case "number":
      return typeof value === "number" ? { inner: value } : null;
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? { inner: value }
        : null;
    case "boolean":
      return typeof value === "boolean" ? { inner: value } : null;
    case "array":
      return Array.isArray(value) ? { inner: value } : null;
  }
}

/**
 * Whether a built-in dispatch result reached argument validation — i.e. cleared
 * the RBAC/assignment gates in executeArchestraTool. A success has no error; a
 * post-gate validation error carries the `archestraValidation` descriptor
 * (index.ts). A gate denial is a plain error with neither, so it reads false.
 * Deliberately conservative: a handler/output error that runs *after* the gates
 * also lacks that descriptor and so suppresses the note too. That is the safe
 * direction — the note is only a self-correction hint, and erring toward
 * suppression keeps any not-yet-enumerated error path from leaking a param's
 * declared type to a caller the gates would have refused.
 */
function reachedArgValidation(result: CallToolResult): boolean {
  if (!result.isError) {
    return true;
  }
  return isRecord(result._meta) && "archestraValidation" in result._meta;
}

/**
 * Disclose a fired envelope repair on the tool result (success or failure),
 * so the model sees what was attempted and self-corrects in-context.
 */
function appendEnvelopeRepairNote(
  result: CallToolResult,
  repairedParams: string[],
): CallToolResult {
  if (repairedParams.length === 0) {
    return result;
  }
  const names = repairedParams.map((name) => `"${name}"`).join(", ");
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: `Note: run_tool unwrapped a wrapper object around ${names} in tool_args — pass the value directly next time.`,
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
