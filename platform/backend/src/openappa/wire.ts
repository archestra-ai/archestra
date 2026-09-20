/**
 * Denial notice restoration on the three provider wire formats.
 *
 * The client holds notice calls in its history; the provider must see the calls
 * the model actually made. Restoration swaps each notice call back to the
 * original tool and arguments in place and replaces the notice's result with
 * the ruling, touching nothing else — thinking blocks, reasoning items,
 * call ids and item order all survive, which is what keeps a restored turn
 * valid for the provider and identical on every request.
 *
 * Structural reading only, the way `collectDeclaredToolNames` reads bodies: one
 * rewriter per container shape rather than a typed model per provider, so a
 * body this proxy forwards but does not fully model still restores correctly.
 */
import {
  APPA_PARENT_HEADER,
  APPA_SESSION_HEADER,
  type SupportedProviderDiscriminator,
} from "@archestra/shared";
import config from "@/config";
import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import {
  type NoticeOriginalCall,
  readNotice,
  readRemedyExecution,
} from "./notice";
import type { OfferJws } from "./offer-claims";

export type AppaWireFamily =
  | "anthropic:messages"
  | "openai:responses"
  | "openai:chatCompletions";

export type AppaSessionIdentity = {
  sessionId?: string;
  parentId?: string;
  /** The field that supplied the selected session id. */
  provenance?:
    | "appa-header"
    | "claude-code-header"
    | "claude-metadata"
    | "opencode-session"
    | "prompt-cache-key"
    | "metadata-session-id"
    | "conversation"
    | "none";
};

/** The wire families this proxy can restore notices on. */
export function appaWireFamily(
  interactionType: string,
): AppaWireFamily | undefined {
  return APPA_WIRE_FAMILY_BY_INTERACTION_TYPE[
    interactionType as SupportedProviderDiscriminator
  ];
}

/**
 * Collects the signed offers the notice calls in request history carry.
 * With `currentTurnOnly`, only notices issued since the last message the user
 * wrote count: an offer from an earlier turn was spent or released with it.
 */
export function collectSignedOfferClaims(params: {
  family: AppaWireFamily;
  body: unknown;
  isNoticeTool: (name: string) => boolean;
  mayBeNoticeTool: (name: string) => boolean;
  currentTurnOnly?: boolean;
}): OfferJws[] {
  const claims: OfferJws[] = [];
  const calls = toolCallSites({
    family: params.family,
    body: params.currentTurnOnly ? currentTurnBody(params) : params.body,
    match: (name) => params.isNoticeTool(name) || params.mayBeNoticeTool(name),
  });
  for (const call of calls) {
    const notice = readNotice({ callId: call.id, arguments: call.arguments });
    if (!notice?.offers) continue;
    claims.push(...notice.offers);
  }
  return claims;
}

/**
 * Restores notice tool calls in request history back to original calls and rulings.
 * Updates model-visible history in place.
 */
export function restoreAppaNotices(params: {
  family: AppaWireFamily;
  body: unknown;
  /** Resolved to this platform's notice tool. */
  isNoticeTool: (name: string) => boolean;
  /** Merely spelled like it: a malformed notice is someone else's call. */
  mayBeNoticeTool: (name: string) => boolean;
}): void {
  const calls = toolCallSites({
    family: params.family,
    body: params.body,
    match: (name) => params.isNoticeTool(name) || params.mayBeNoticeTool(name),
  });
  for (const call of calls) {
    const notice = readNotice({ callId: call.id, arguments: call.arguments });
    // Unparseable notices remain as recorded so sessions continue without interruption.
    if (!notice) continue;
    // A denied call to a custom tool reached the client as an ordinary function
    // call, because the notice tool is one; the notice's record is what says to
    // call it a custom tool call again, since the request carrying it back may
    // declare no tools at all.
    const custom = notice.original.kind === "custom";
    if (!call.restore(notice.tool, notice.original, notice.namespace)) continue;
    restoreResult({
      ...params,
      callId: call.id,
      result: notice.result,
      custom,
    });
  }
}

/**
 * Removes the gateway-only execution receipt from a direct control call in
 * provider history. It deliberately does not restore custom calls: only the
 * function control call the provider actually emitted can carry this receipt.
 */
export function restoreAppaRemedyExecutions(params: {
  family: AppaWireFamily;
  body: unknown;
  isControlTool: (name: string) => boolean;
  /** Restores typed historical records only; never declares a tool available. */
  allowHistoricalControl?: boolean;
}): string | undefined {
  let historicalControlToolName: string | undefined;
  const calls = toolCallSites({
    family: params.family,
    body: params.body,
    match: (name) =>
      params.isControlTool(name) || params.allowHistoricalControl === true,
  });
  for (const call of calls) {
    if (call.kind !== "function") continue;
    const execution = readRemedyExecution({
      callId: call.id,
      toolName: call.name,
      arguments: call.arguments,
    });
    if (!execution) continue;
    historicalControlToolName = execution.tool_name;
    call.restoreFunctionArguments({
      kind: "function",
      arguments: execution.parsedOriginalArguments,
      rawArguments: execution.original_arguments,
    });
  }
  return historicalControlToolName;
}

/**
 * Removes arguments the proxy stamped onto the model's calls on their way to
 * the client from those calls in provider history, so the provider gets each
 * call back as the model made it. Only function calls carry them.
 */
export function stripProxyArguments(params: {
  family: AppaWireFamily;
  body: unknown;
  /** Resolved to a tool whose calls the proxy stamps. */
  isStampedTool: (name: string) => boolean;
  names: ReadonlySet<string>;
}): void {
  const calls = toolCallSites({
    family: params.family,
    body: params.body,
    match: params.isStampedTool,
  });
  for (const call of calls) {
    if (call.kind !== "function") continue;
    const argumentsValue = asRecord(
      typeof call.arguments === "string"
        ? parseJson(call.arguments)
        : call.arguments,
    );
    if (!argumentsValue) continue;
    const kept = Object.entries(argumentsValue).filter(
      ([name]) => !params.names.has(name),
    );
    if (kept.length === Object.keys(argumentsValue).length) continue;
    call.restoreFunctionArguments({
      kind: "function",
      arguments: Object.fromEntries(kept),
    });
  }
}

/**
 * Removes parameters from a declared tool's input schema, wherever its wire
 * keeps it: Anthropic's `input_schema`, the Responses and Gemini `parameters`,
 * Gemini's `parametersJsonSchema`, Chat Completions' `function.parameters`,
 * Bedrock Converse's `toolSpec.inputSchema.json`.
 */
export function stripDeclaredParameters(params: {
  tool: unknown;
  names: ReadonlySet<string>;
}): void {
  const schema = declaredInputSchema(params.tool);
  const properties = asRecord(schema?.properties);
  if (!schema || !properties) return;
  const kept = Object.entries(properties).filter(
    ([name]) => !params.names.has(name),
  );
  if (kept.length === Object.keys(properties).length) return;
  schema.properties = Object.fromEntries(kept);
  // Strict function schemas list every property as required.
  if (Array.isArray(schema.required))
    schema.required = schema.required.filter(
      (name) => typeof name !== "string" || !params.names.has(name),
    );
}

/** Removes tools from every declaration container, by exact wire name. */
export function stripAppaTools(params: {
  body: unknown;
  names: ReadonlySet<string>;
}): void {
  if (params.names.size === 0) return;
  for (const { holder, key } of toolContainers(params.body)) {
    const declared = holder[key];
    if (!Array.isArray(declared)) continue;
    holder[key] = declared.filter((tool) => {
      const group = groupedMembers(tool);
      if (group) {
        // A group keeps its other tools; only the named one leaves.
        group.holder[group.key] = group.members.filter(
          (member) => !params.names.has(declaredToolName(member) ?? ""),
        );
        return true;
      }
      const name = declaredToolName(tool);
      return name === undefined || !params.names.has(name);
    });
  }
}

/**
 * Every tool this request declares, in every container and namespace.
 *
 * Codex groups an MCP server's tools under one `namespace` declaration and
 * calls a member by its own name, so a namespace's members are returned under
 * those names.
 */
export function declaredTools(body: unknown): unknown[] {
  return toolContainers(body)
    .flatMap(({ holder, key }) =>
      Array.isArray(holder[key]) ? (holder[key] as unknown[]) : [],
    )
    .flatMap((tool) => groupedMembers(tool)?.members ?? [tool]);
}

/**
 * Tool name → the namespace this request declares it in, for the tools Codex
 * declares inside a `namespace` block. The provider expects a call to such a
 * tool to name its namespace, so a notice records it for restoration.
 */
export function declaredToolNamespaces(body: unknown): Map<string, string> {
  const namespaces = new Map<string, string>();
  for (const { holder, key } of toolContainers(body)) {
    if (!Array.isArray(holder[key])) continue;
    for (const tool of holder[key] as unknown[]) {
      const group = groupedMembers(tool);
      const namespace = asRecord(tool)?.name;
      if (!group || typeof namespace !== "string") continue;
      for (const member of group.members) {
        const name = declaredToolName(member);
        if (name !== undefined && !namespaces.has(name))
          namespaces.set(name, namespace);
      }
    }
  }
  return namespaces;
}

/**
 * Where a request declares its tools: the top-level containers of the
 * Anthropic and OpenAI families, Bedrock Converse's `toolConfig.tools`, and
 * the `additional_tools` input items of a Responses request, where Codex
 * declares the tools of the models it drives over the lite Responses wire.
 */
function toolContainers(
  body: unknown,
): Array<{ holder: Record<string, unknown>; key: string }> {
  const record = asRecord(body);
  if (!record) return [];
  const containers = TOOL_CONTAINERS.map((key) => ({ holder: record, key }));
  const toolConfig = asRecord(record.toolConfig);
  if (toolConfig) containers.push({ holder: toolConfig, key: "tools" });
  if (Array.isArray(record.input))
    for (const item of record.input) {
      const entry = asRecord(item);
      if (entry?.type === "additional_tools")
        containers.push({ holder: entry, key: "tools" });
    }
  for (const { holder, key } of containers) {
    // Gemini accepts a lone tool object where it accepts a list of them.
    if (asRecord(holder[key])) holder[key] = [holder[key]];
  }
  return containers;
}

/**
 * A declaration that groups tools: a Codex namespace, whose members the
 * model calls by their own names, or Gemini's `functionDeclarations` entry.
 */
function groupedMembers(
  tool: unknown,
):
  | { holder: Record<string, unknown>; key: string; members: unknown[] }
  | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  const members = namespaceMembers(tool);
  if (members) return { holder: record, key: "tools", members };
  if (Array.isArray(record.functionDeclarations))
    return {
      holder: record,
      key: "functionDeclarations",
      members: record.functionDeclarations,
    };
  return undefined;
}

/**
 * Tools the provider runs on the model's behalf, which never reach this proxy
 * as a tool call it can gate — Anthropic's server tools and hosted MCP, the
 * Responses `mcp` tool. A session that declares one is refused rather than
 * governed in part.
 */
export function providerHostedTool(tool: unknown): string | undefined {
  const record = asRecord(tool);
  const type = record?.type;
  if (typeof type !== "string") return undefined;
  // Every typed declaration outside this allowlist is provider-owned until an
  // adapter explicitly models how the proxy observes and gates its calls.
  return CLIENT_RUN_TOOL_TYPES.has(type) ? undefined : type;
}

/**
 * A provider-hosted tool whose result this proxy can still withhold: a
 * read-only lookup on a wire whose response adapter surfaces hosted calls, so
 * what the provider ran is ruled on before any of it reaches the client.
 */
export function isResultGovernedHostedTool(params: {
  family: AppaWireFamily | undefined;
  tool: unknown;
}): boolean {
  const hosted = providerHostedTool(params.tool);
  if (!hosted || !params.family) return false;
  return RESULT_GOVERNED_HOSTED_TOOL_TYPES[params.family]?.has(hosted) === true;
}

/**
 * The client session this request belongs to, as the client itself reports it.
 *
 * A session id cannot come from static client configuration: it changes every
 * time a person starts a new session, and no external client has logic to mint
 * one for us. What each client does have is its own notion of a session, which
 * it already puts on the wire — so the adapter reads it from there, and a
 * client needs no OpenAPPA-specific setup at all.
 *
 * An explicit `X-Appa-Session-ID` still wins where it is sent (Chat, the
 * qualification harness, any caller that manages roots deliberately).
 *
 * What each family offers, and why:
 *  - anthropic:messages — Claude Code sends `x-claude-code-session-id`, and
 *    repeats the same uuid inside `metadata.user_id` (a JSON blob of
 *    device/account/session). Either is per-session and survives a restart of
 *    the same session.
 *  - openai:responses / chatCompletions — OpenCode sends `x-opencode-session`.
 *    Other OpenAI-family requests fall back to request fields that are stable
 *    across a conversation: `prompt_cache_key` (OpenAI's own per-conversation
 *    cache partition), then an explicit `metadata.session_id`, then
 *    `conversation`.
 */
export function appaSessionIdentity(params: {
  family: AppaWireFamily;
  body: unknown;
  headers: Record<string, unknown>;
}): AppaSessionIdentity {
  const header = (name: string): string | undefined => {
    const value = params.headers[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const explicit = header(APPA_SESSION_HEADER.toLowerCase());
  const parentId = header(APPA_PARENT_HEADER.toLowerCase());
  if (explicit)
    return {
      sessionId: explicit,
      parentId,
      provenance: "appa-header",
    };

  const body = asRecord(params.body);
  const field = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  if (params.family === "anthropic:messages") {
    const claudeCode = header("x-claude-code-session-id");
    const userId = field(asRecord(body?.metadata)?.user_id);
    const metadataSession = userId
      ? (parseClaudeMetadataSessionId(userId) ?? userId)
      : undefined;
    if (claudeCode) {
      return {
        sessionId: claudeCode,
        parentId,
        provenance: "claude-code-header",
      };
    }
    if (metadataSession) {
      // Claude Code session ID from user_id metadata.
      return {
        sessionId: metadataSession,
        parentId,
        provenance: "claude-metadata",
      };
    }
    return { parentId, provenance: "none" };
  }

  const openCodeSession = header("x-opencode-session");
  if (openCodeSession) {
    return {
      sessionId: openCodeSession,
      parentId,
      provenance: "opencode-session",
    };
  }

  const cacheKey = field(body?.prompt_cache_key);
  const declared = field(asRecord(body?.metadata)?.session_id);
  const conversation = field(body?.conversation);
  if (cacheKey)
    return {
      sessionId: cacheKey,
      parentId,
      provenance: "prompt-cache-key",
    };
  if (declared)
    return {
      sessionId: declared,
      parentId,
      provenance: "metadata-session-id",
    };
  return conversation
    ? {
        sessionId: conversation,
        parentId,
        provenance: "conversation",
      }
    : { parentId, provenance: "none" };
}

/**
 * Computes turn boundary IDs for this request.
 * User messages start a turn; tool results continue the active turn.
 */
export function appaTurnBoundaries(params: {
  family: AppaWireFamily;
  body: unknown;
}): { promptOperationId?: string; turnEndOperationId: string } {
  // A fingerprint of the history, not a hash of any secret: it only makes a
  // retried request report the same turn.
  const digest = digestOf(canonicalJson(params.body ?? null));
  return {
    ...(endsWithUserTurn(params)
      ? { promptOperationId: `prompt:${digest}` }
      : {}),
    turnEndOperationId: `turn_end:${digest}`,
  };
}

/**
 * The wire name of a declared tool: Anthropic, Responses and Gemini name the
 * tool itself; Chat Completions nests it under `function`, or under `custom`
 * for a free-form tool; Bedrock Converse under `toolSpec`.
 */
export function declaredToolName(tool: unknown): string | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  if (typeof record.name === "string") return record.name;
  for (const nested of [record.function, record.custom, record.toolSpec]) {
    const inner = asRecord(nested);
    if (typeof inner?.name === "string") return inner.name;
  }
  return undefined;
}

// === Internal helpers ===

/**
 * The transport's wire family, not a provider-name suffix. Keep this explicit:
 * a future provider with a similarly named interaction type must opt in after
 * its request and history shapes are audited.
 */
const APPA_WIRE_FAMILY_BY_INTERACTION_TYPE: Partial<
  Record<SupportedProviderDiscriminator, AppaWireFamily>
> = {
  "anthropic:messages": "anthropic:messages",
  "bedrock:invoke": "anthropic:messages",
  "openai:responses": "openai:responses",
  "github-copilot:responses": "openai:responses",
  "perplexity:responses": "openai:responses",
  "openai:chatCompletions": "openai:chatCompletions",
  "azure:chatCompletions": "openai:chatCompletions",
  "archestra:chatCompletions": "openai:chatCompletions",
  "cerebras:chatCompletions": "openai:chatCompletions",
  "deepseek:chatCompletions": "openai:chatCompletions",
  "github-copilot:chatCompletions": "openai:chatCompletions",
  "groq:chatCompletions": "openai:chatCompletions",
  "kimi:chatCompletions": "openai:chatCompletions",
  "microsoft-365-copilot:chatCompletions": "openai:chatCompletions",
  "minimax:chatCompletions": "openai:chatCompletions",
  "mistral:chatCompletions": "openai:chatCompletions",
  "ollama:chatCompletions": "openai:chatCompletions",
  "openrouter:chatCompletions": "openai:chatCompletions",
  "perplexity:chatCompletions": "openai:chatCompletions",
  "vllm:chatCompletions": "openai:chatCompletions",
  "xai:chatCompletions": "openai:chatCompletions",
  "zhipuai:chatCompletions": "openai:chatCompletions",
};

/** Where the three families declare tools; Responses adds `additional_tools`. */
const TOOL_CONTAINERS = ["tools", "additional_tools"] as const;

const CLIENT_RUN_TOOL_TYPES = new Set([
  "function",
  "custom",
  "namespace",
  "tool_search",
]);

const RESULT_GOVERNED_HOSTED_TOOL_TYPES: Partial<
  Record<AppaWireFamily, ReadonlySet<string>>
> = {
  "openai:responses": new Set(["web_search", "web_search_preview"]),
};

/** Adjusts tool call IDs to match expected provider prefixes (fc_, ctc_). */
function itemIdOfKind(id: string, type: keyof typeof ITEM_ID_PREFIXES): string {
  const prefix = ITEM_ID_PREFIXES[type];
  for (const other of Object.values(ITEM_ID_PREFIXES)) {
    if (other !== prefix && id.startsWith(other))
      return `${prefix}${id.slice(other.length)}`;
  }
  return id;
}

const ITEM_ID_PREFIXES = {
  function_call: "fc_",
  custom_tool_call: "ctc_",
  function_call_output: "fco_",
  custom_tool_call_output: "ctco_",
} as const;

function declaredInputSchema(
  tool: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  return (
    asRecord(record.input_schema) ??
    asRecord(record.parameters) ??
    asRecord(record.parametersJsonSchema) ??
    asRecord(asRecord(record.function)?.parameters) ??
    asRecord(asRecord(asRecord(record.toolSpec)?.inputSchema)?.json)
  );
}

/** Extracts member tools declared inside a Codex namespace declaration. */
function namespaceMembers(tool: unknown): unknown[] | undefined {
  const record = asRecord(tool);
  return record?.type === "namespace" && Array.isArray(record.tools)
    ? record.tools
    : undefined;
}

/** Returns true if the final item in history is a user message rather than a tool result. */
function endsWithUserTurn(params: {
  family: AppaWireFamily;
  body: unknown;
}): boolean {
  const history = historyEntries(params);
  if (!history) {
    return (
      params.family === "openai:responses" &&
      typeof asRecord(params.body)?.input === "string"
    );
  }
  return isUserAuthored(params.family, history.at(-1));
}

/**
 * The body cut down to the current turn: the history after the last message
 * the user wrote. A shallow copy, for reading; the request is left untouched.
 */
function currentTurnBody(params: {
  family: AppaWireFamily;
  body: unknown;
}): unknown {
  const history = historyEntries(params);
  if (!history) return params.body;
  const lastUserMessage = history.findLastIndex((entry) =>
    isUserAuthored(params.family, entry),
  );
  return {
    ...asRecord(params.body),
    [historyKey(params.family)]: history.slice(lastUserMessage + 1),
  };
}

function historyKey(family: AppaWireFamily): "input" | "messages" {
  return family === "openai:responses" ? "input" : "messages";
}

function historyEntries(params: {
  family: AppaWireFamily;
  body: unknown;
}): unknown[] | undefined {
  return asArray(asRecord(params.body)?.[historyKey(params.family)]);
}

/** A user message is a tool-result turn only when every content block is a result. */
function isUserAuthored(family: AppaWireFamily, entry: unknown): boolean {
  const record = asRecord(entry);
  if (!record || record.role !== "user") return false;
  if (family === "openai:responses")
    return (
      record.type !== "function_call_output" &&
      record.type !== "custom_tool_call_output"
    );
  if (family === "openai:chatCompletions") return true;
  const content = asArray(record.content);
  return (
    content === undefined ||
    content.length === 0 ||
    content.some((block) => asRecord(block)?.type !== "tool_result")
  );
}

type ToolCallSite = {
  id: string;
  name: string;
  kind: "function" | "custom";
  arguments: unknown;
  restore: (
    tool: string,
    original: NoticeOriginalCall,
    namespace?: string,
  ) => boolean;
  restoreFunctionArguments: (original: NoticeFunctionCall) => void;
};

type NoticeFunctionCall = Extract<NoticeOriginalCall, { kind: "function" }>;

function toolCallSites(params: {
  family: AppaWireFamily;
  body: unknown;
  match: (name: string) => boolean;
}): ToolCallSite[] {
  const found: ToolCallSite[] = [];
  // Claimed by name alone. The client echoes the name the proxy sent, and a
  // tool of its own that happens to take a `ruling` argument must never be
  // read as a notice — nor rejected as a malformed one.
  const claim = (name: unknown): boolean =>
    typeof name === "string" && params.match(name);

  if (params.family === "anthropic:messages") {
    for (const block of anthropicBlocks(params.body)) {
      if (block.type !== "tool_use") continue;
      if (!claim(block.name) || typeof block.id !== "string") continue;
      found.push({
        id: block.id,
        name: block.name as string,
        kind: "function",
        arguments: block.input,
        restore: (tool, original) => {
          if (original.kind !== "function") return false;
          block.name = tool;
          block.input = original.arguments;
          return true;
        },
        restoreFunctionArguments: (original) => {
          block.input = original.arguments;
        },
      });
    }
    return found;
  }

  if (params.family === "openai:responses") {
    for (const item of responsesItems(params.body)) {
      if (item.type !== "function_call" && item.type !== "custom_tool_call")
        continue;
      const id = item.call_id;
      if (!claim(item.name) || typeof id !== "string") continue;
      found.push({
        id,
        name: item.name as string,
        kind: item.type === "function_call" ? "function" : "custom",
        arguments: item.arguments ?? item.input,
        restore: (tool, original, namespace) => {
          item.name = tool;
          // The client echoes the notice call under the notice tool's
          // namespace, or none; the denied call is put back under its own.
          if (namespace) item.namespace = namespace;
          else delete item.namespace;
          // The item id follows the call's kind too, should a client have
          // minted one for the notice call by its own kind.
          const type =
            original.kind === "custom" ? "custom_tool_call" : "function_call";
          if (item.type !== type && typeof item.id === "string")
            item.id = itemIdOfKind(item.id, type);
          item.type = type;
          if (original.kind === "custom") {
            // Its one argument is the free-form text the model wrote.
            item.input = original.input;
            delete item.arguments;
            return true;
          }
          item.arguments =
            original.rawArguments ?? JSON.stringify(original.arguments);
          delete item.input;
          return true;
        },
        restoreFunctionArguments: (original) => {
          item.arguments =
            original.rawArguments ?? JSON.stringify(original.arguments);
          delete item.input;
        },
      });
    }
    return found;
  }

  for (const message of chatMessages(params.body)) {
    if (!Array.isArray(message.tool_calls)) continue;
    for (const entry of message.tool_calls) {
      const call = asRecord(entry);
      const fn = asRecord(call?.function);
      if (!call || !fn || typeof call.id !== "string") continue;
      if (!claim(fn.name)) continue;
      found.push({
        id: call.id,
        name: fn.name as string,
        kind: "function",
        arguments: fn.arguments,
        restore: (tool, original) => {
          if (original.kind !== "function") return false;
          fn.name = tool;
          fn.arguments =
            original.rawArguments ?? JSON.stringify(original.arguments);
          return true;
        },
        restoreFunctionArguments: (original) => {
          fn.arguments =
            original.rawArguments ?? JSON.stringify(original.arguments);
        },
      });
    }
  }
  return found;
}

/**
 * Replaces the notice call's result with the ruling.
 *
 * A client that recorded no result for the notice — an interrupted turn, a
 * cleared result — still gets the denial: the provider is owed one result per
 * call, and it must be the ruling rather than whatever the client wrote.
 */
function restoreResult(params: {
  family: AppaWireFamily;
  body: unknown;
  callId: string;
  result: string;
  custom?: boolean;
}): void {
  if (params.family === "anthropic:messages") {
    for (const block of anthropicBlocks(params.body)) {
      if (block.type === "tool_result" && block.tool_use_id === params.callId) {
        block.content = params.result;
        block.is_error = true;
        return;
      }
    }
    insertAnthropicResult(params);
    return;
  }

  if (params.family === "openai:responses") {
    for (const item of responsesItems(params.body)) {
      if (
        (item.type === "function_call_output" ||
          item.type === "custom_tool_call_output") &&
        item.call_id === params.callId
      ) {
        // The output's kind follows the call's: a custom tool call restored
        // from a notice is answered by a custom tool call output, under an
        // item id of that kind, which the provider checks.
        const type = params.custom
          ? "custom_tool_call_output"
          : "function_call_output";
        if (item.type !== type && typeof item.id === "string")
          item.id = itemIdOfKind(item.id, type);
        item.type = type;
        item.output = params.result;
        return;
      }
    }
    insertResponsesResult(params);
    return;
  }

  for (const message of chatMessages(params.body)) {
    if (message.role === "tool" && message.tool_call_id === params.callId) {
      message.content = params.result;
      return;
    }
  }
  insertChatResult(params);
}

function insertAnthropicResult(params: {
  body: unknown;
  callId: string;
  result: string;
}): void {
  const messages = asArray(asRecord(params.body)?.messages);
  if (!messages) return;
  const alreadyHasResult = messages.some((message) =>
    asArray(asRecord(message)?.content)?.some((block) => {
      const record = asRecord(block);
      return (
        record?.type === "tool_result" && record.tool_use_id === params.callId
      );
    }),
  );
  if (alreadyHasResult) return;

  const index = messages.findIndex((message) =>
    asArray(asRecord(message)?.content)?.some((block) => {
      const record = asRecord(block);
      return record?.type === "tool_use" && record.id === params.callId;
    }),
  );
  if (index < 0) return;
  // When a turn is interrupted, append the ruling so every tool call has a result.
  const result = {
    type: "tool_result",
    tool_use_id: params.callId,
    content: params.result,
    is_error: true,
  };

  // If a subsequent user message exists, prepend the tool_result into it
  // to satisfy Anthropic's alternating role constraint.
  const next = asRecord(messages[index + 1]);
  if (next?.role === "user") {
    const content = asArray(next.content);
    if (content) {
      content.unshift(result);
      return;
    }
    if (typeof next.content === "string") {
      next.content = [result, { type: "text", text: next.content }];
      return;
    }
  }

  messages.splice(index + 1, 0, { role: "user", content: [result] });
}

function insertResponsesResult(params: {
  body: unknown;
  callId: string;
  result: string;
}): void {
  const body = asRecord(params.body);
  const input = asArray(body?.input);
  if (!input) return;
  const alreadyHasResult = input.some((item) => {
    const record = asRecord(item);
    return (
      (record?.type === "function_call_output" ||
        record?.type === "custom_tool_call_output") &&
      record.call_id === params.callId
    );
  });
  if (alreadyHasResult) return;

  const index = input.findIndex((item) => {
    const record = asRecord(item);
    return (
      (record?.type === "function_call" ||
        record?.type === "custom_tool_call") &&
      record.call_id === params.callId
    );
  });
  if (index < 0) return;
  const custom = asRecord(input[index])?.type === "custom_tool_call";
  input.splice(index + 1, 0, {
    type: custom ? "custom_tool_call_output" : "function_call_output",
    call_id: params.callId,
    output: params.result,
  });
}

function insertChatResult(params: {
  body: unknown;
  callId: string;
  result: string;
}): void {
  const messages = asArray(asRecord(params.body)?.messages);
  if (!messages) return;
  const alreadyHasResult = messages.some((message) => {
    const record = asRecord(message);
    return record?.role === "tool" && record.tool_call_id === params.callId;
  });
  if (alreadyHasResult) return;

  const index = messages.findIndex((message) =>
    asArray(asRecord(message)?.tool_calls)?.some(
      (call) => asRecord(call)?.id === params.callId,
    ),
  );
  if (index < 0) return;
  messages.splice(index + 1, 0, {
    role: "tool",
    tool_call_id: params.callId,
    content: params.result,
  });
}

function anthropicBlocks(body: unknown): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const message of asArray(asRecord(body)?.messages) ?? []) {
    for (const block of asArray(asRecord(message)?.content) ?? []) {
      const record = asRecord(block);
      if (record) blocks.push(record);
    }
  }
  return blocks;
}

function responsesItems(body: unknown): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const item of asArray(asRecord(body)?.input) ?? []) {
    const record = asRecord(item);
    if (record) items.push(record);
  }
  return items;
}

function chatMessages(body: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const message of asArray(asRecord(body)?.messages) ?? []) {
    const record = asRecord(message);
    if (record) messages.push(record);
  }
  return messages;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_CANONICAL_JSON_DEPTH = 64;

/** Serializes value to canonical JSON, bounded by depth and proxy bodyLimit. */
export function canonicalJson(
  value: unknown,
  options?: { maxDepth?: number; maxBytes?: number },
): string {
  const maxDepth = options?.maxDepth ?? MAX_CANONICAL_JSON_DEPTH;
  const maxBytes = options?.maxBytes ?? config.api.bodyLimit;
  let byteCount = 0;

  function serialize(val: unknown, depth: number): string {
    if (depth >= maxDepth) {
      return '"[depth-exceeded]"';
    }
    if (byteCount >= maxBytes) {
      return '"[size-exceeded]"';
    }

    if (Array.isArray(val)) {
      const items = val.map((item) => {
        if (
          item === undefined ||
          typeof item === "function" ||
          typeof item === "symbol"
        ) {
          byteCount += 4;
          return "null";
        }
        return serialize(item, depth + 1);
      });
      byteCount += 2 + (items.length > 1 ? items.length - 1 : 0);
      return `[${items.join(",")}]`;
    }

    const record = asRecord(val);
    if (record) {
      const entries = Object.keys(record)
        .sort()
        .flatMap((key) => {
          const entry = record[key];
          if (
            entry === undefined ||
            typeof entry === "function" ||
            typeof entry === "symbol"
          ) {
            return [];
          }
          const serializedKey = JSON.stringify(key);
          byteCount += serializedKey.length + 1;
          const serializedValue = serialize(entry, depth + 1);
          return [`${serializedKey}:${serializedValue}`];
        });
      byteCount += 2 + (entries.length > 1 ? entries.length - 1 : 0);
      return `{${entries.join(",")}}`;
    }

    const primitive = JSON.stringify(val) ?? "null";
    byteCount += primitive.length;
    return primitive;
  }

  try {
    const result = serialize(value, 0);
    if (byteCount > maxBytes) {
      return '"[size-exceeded]"';
    }
    return result;
  } catch (err) {
    if (err instanceof RangeError) {
      return '"[stack-overflow]"';
    }
    throw err;
  }
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Non-cryptographic fingerprint digest for retry idempotency. */
function digestOf(text: string): string {
  return fingerprint(text);
}

/**
 * A stable 128-bit fingerprint of a string: two FNV-1a lanes over the text,
 * hex-encoded, plus its length.
 *
 * CodeQL [js/insufficient-password-hash] False positive: This is a non-cryptographic
 * FNV-1a fingerprint for turn-boundary idempotency, never used for passwords or secrets.
 */
function fingerprint(text: string): string {
  const lanes = [0x811c9dc5, 0x01000193 ^ 0x811c9dc5];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane++) {
      const mixed = (lanes[lane] ^ code ^ (index & 0xff)) >>> 0;
      lanes[lane] = Math.imul(mixed, 0x01000193) >>> 0;
    }
  }
  return (
    lanes.map((lane) => lane.toString(16).padStart(8, "0")).join("") +
    text.length.toString(16).padStart(8, "0")
  );
}
