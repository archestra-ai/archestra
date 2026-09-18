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
import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import {
  type NoticeOriginalCall,
  readNotice,
  readRemedyExecution,
} from "./notice";

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
 * Restores every notice call in this request's history, in place.
 *
 * Model-visible history only. What the runtime makes of a call and its result
 * stays the runtime's own record, so a client that writes a notice of its own
 * changes what the model reads and nothing that is enforced.
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
 *  - openai:responses / chatCompletions — Codex and OpenCode carry no session
 *    header, so fall back to the request fields that are stable across a
 *    conversation: `prompt_cache_key` (OpenAI's own per-conversation cache
 *    partition), then an explicit `metadata.session_id`, then `conversation`.
 *
 * Returns nothing when the client identifies no session; the caller decides
 * what to bind then, and must not simply refuse the request.
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
      // Claude Code's JSON blob, its older `user_…_session_<uuid>` string, or
      // an opaque string elsewhere. The proxy log reads the same forms, so the
      // two records join on one id.
      return {
        sessionId: metadataSession,
        parentId,
        provenance: "claude-metadata",
      };
    }
    return { parentId, provenance: "none" };
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
 * The turn this request starts, when it starts one.
 *
 * A request whose last message is the user speaking opens a turn; one that ends
 * in tool results is the same turn continuing. The ids are digests of the
 * history they describe, so a retried request reports the same turn rather than
 * a second one, and two identical prompts in one conversation still differ.
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

/**
 * The item id of a Responses call or output, respelled for its kind: an id
 * starts with `fc_` on a function call and `ctc_` on a custom tool call, with
 * `fco_` and `ctco_` on their outputs, and the provider rejects an id under
 * another kind's prefix. An id under no known prefix is left alone.
 */
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

/**
 * A namespace declaration's members, under the names the model calls them by.
 *
 * Codex groups an MCP server's tools under one `namespace` declaration and then
 * calls a member by its own name, not by a namespaced one, so the members are
 * what this proxy must resolve, strip and match against.
 */
function namespaceMembers(tool: unknown): unknown[] | undefined {
  const record = asRecord(tool);
  return record?.type === "namespace" && Array.isArray(record.tools)
    ? record.tools
    : undefined;
}

/**
 * True when the last thing in this history is the user, not a tool result.
 *
 * Anthropic and Chat Completions put results in a message of their own, so the
 * shape is the role plus the block types; Responses puts them in the input list
 * as their own items.
 */
function endsWithUserTurn(params: {
  family: AppaWireFamily;
  body: unknown;
}): boolean {
  if (params.family === "openai:responses") {
    const input = asArray(asRecord(params.body)?.input);
    if (!input) return typeof asRecord(params.body)?.input === "string";
    const last = asRecord(input.at(-1));
    if (!last) return false;
    return (
      last.role === "user" &&
      last.type !== "function_call_output" &&
      last.type !== "custom_tool_call_output"
    );
  }
  const messages = asArray(asRecord(params.body)?.messages);
  const last = asRecord(messages?.at(-1));
  if (!last || last.role !== "user") return false;
  if (params.family === "openai:chatCompletions") return true;
  const content = asArray(last.content);
  return (
    content === undefined ||
    !content.some((block) => asRecord(block)?.type === "tool_result")
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
const MAX_CANONICAL_JSON_BYTES = 2 * 1024 * 1024; // 2 MB

/** JSON's canonical form for semantic retry fingerprints, bounded by depth and size. */
export function canonicalJson(
  value: unknown,
  options?: { maxDepth?: number; maxBytes?: number },
): string {
  const maxDepth = options?.maxDepth ?? MAX_CANONICAL_JSON_DEPTH;
  const maxBytes = options?.maxBytes ?? MAX_CANONICAL_JSON_BYTES;
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
      const result = `[${items.join(",")}]`;
      byteCount += result.length;
      return result;
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
          const serializedValue = serialize(entry, depth + 1);
          return [`${serializedKey}:${serializedValue}`];
        });
      const result = `{${entries.join(",")}}`;
      byteCount += result.length;
      return result;
    }

    const primitive = JSON.stringify(val) ?? "null";
    byteCount += primitive.length;
    return primitive;
  }

  try {
    return serialize(value, 0);
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

/**
 * A stable non-cryptographic digest of a text. Equal texts give equal digests,
 * which is what a retried request needs to report the same turn.
 */
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
