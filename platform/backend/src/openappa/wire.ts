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
 * Structural reading only, the way `declaredToolEntries` reads declarations:
 * one rewriter per container shape rather than a typed model per provider, so
 * a body this proxy forwards but does not fully model still restores correctly.
 */
import {
  APPA_PARENT_HEADER,
  APPA_SESSION_HEADER,
  type SupportedProviderDiscriminator,
} from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { OpenAppaSessionModel } from "@/models";
import { parseClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import { clientSessionId } from "./actor";
import {
  type AppaChildTrajectoryReceipt,
  appendChildTrajectoryReceipt,
  stripChildTrajectoryReceipts,
} from "./child-trajectory-receipt";
import {
  type NoticeOriginalCall,
  readNotice,
  readRemedyExecution,
} from "./notice";
import type { OfferJws } from "./offer-claims";
import { appendSessionReceipt, stripSessionReceipts } from "./session-token";
import { parseTrajectoryStamp, type TrajectoryStamp } from "./trajectory-stamp";

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
    | "codex-turn-metadata"
    | "opencode-session-header"
    | "opencode-hosted-header"
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
 * Collects signed offer claims from notice calls in request history.
 * When `currentTurnOnly` is set, considers only notices issued since the last user message.
 */
export function collectSignedOfferClaims(params: {
  family: AppaWireFamily;
  body: unknown;
  isNoticeTool: (name: string, namespace?: string) => boolean;
  mayBeNoticeTool: (name: string) => boolean;
  currentTurnOnly?: boolean;
}): OfferJws[] {
  const claims: OfferJws[] = [];
  const calls = toolCallSites({
    family: params.family,
    body: params.currentTurnOnly ? currentTurnBody(params) : params.body,
    match: (name, namespace) =>
      params.isNoticeTool(name, namespace) || params.mayBeNoticeTool(name),
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
  /** Resolved, with the namespace the call names, to this platform's notice tool. */
  isNoticeTool: (name: string, namespace?: string) => boolean;
  /** Merely spelled like it: a malformed notice is someone else's call. */
  mayBeNoticeTool: (name: string) => boolean;
}): ReadonlySet<string> {
  const restoredCallIds = new Set<string>();
  const calls = toolCallSites({
    family: params.family,
    body: params.body,
    match: (name, namespace) =>
      params.isNoticeTool(name, namespace) || params.mayBeNoticeTool(name),
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
    // A model can call a name no tool has, spaces and all. Put back in
    // history, that name fails the provider's own validation and ends the
    // session; the notice already records the call and its ruling.
    if (!PROVIDER_TOOL_NAME.test(notice.tool)) continue;
    if (!call.restore(notice.tool, notice.original, notice.namespace)) continue;
    restoredCallIds.add(parseTrajectoryStamp(call.id)?.callId ?? call.id);
    restoreResult({
      ...params,
      callId: call.id,
      result: notice.result,
      custom,
    });
  }
  return restoredCallIds;
}

/**
 * Removes the gateway-only execution receipt from a direct control call in
 * provider history. It deliberately does not restore custom calls: only the
 * function control call the provider actually emitted can carry this receipt.
 */
export function restoreAppaRemedyExecutions(params: {
  family: AppaWireFamily;
  body: unknown;
  isControlTool: (name: string, namespace?: string) => boolean;
  /** Restores typed historical records only; never declares a tool available. */
  allowHistoricalControl?: boolean;
}): string | undefined {
  let historicalControlToolName: string | undefined;
  const calls = toolCallSites({
    family: params.family,
    body: params.body,
    match: (name, namespace) =>
      params.isControlTool(name, namespace) ||
      params.allowHistoricalControl === true,
  });
  for (const call of calls) {
    if (call.kind !== "function") continue;
    const execution = readRemedyExecution({
      callId: call.id,
      toolName: call.name,
      namespace: call.namespace,
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
 * Removes proxy-stamped arguments from function calls in provider history.
 * The provider receives each call as originally generated by the model.
 */
export function stripProxyArguments(params: {
  family: AppaWireFamily;
  body: unknown;
  /** Resolved, with the namespace the call names, to a tool the proxy stamps. */
  isStampedTool: (name: string, namespace?: string) => boolean;
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

/**
 * Restores original provider tool-call IDs from trajectory stamps across call
 * and result items. Returns all parsed stamps to identify source context.
 * Runs before any component inspects history.
 *
 * Covers all chat wires. When a conversation switches providers mid-session,
 * it retains previous IDs.
 */
export function restoreTrajectoryStamps(params: {
  interactionType: string;
  body: unknown;
}): TrajectoryStamp[] {
  const found: TrajectoryStamp[] = [];
  const restore = (
    record: Record<string, unknown> | undefined,
    key: string,
  ) => {
    const value = record?.[key];
    const stamp =
      typeof value === "string" ? parseTrajectoryStamp(value) : undefined;
    if (!record || !stamp) return;
    record[key] = stamp.callId;
    found.push(stamp);
  };
  const wire =
    appaWireFamily(params.interactionType) ??
    OTHER_STAMP_WIRES[params.interactionType as SupportedProviderDiscriminator];
  if (wire === "anthropic:messages") {
    for (const block of anthropicBlocks(params.body)) {
      if (block.type === "tool_use") restore(block, "id");
      else if (block.type === "tool_result") restore(block, "tool_use_id");
    }
  } else if (wire === "openai:responses") {
    for (const item of responsesItems(params.body)) restore(item, "call_id");
  } else if (wire === "openai:chatCompletions") {
    for (const message of chatMessages(params.body)) {
      restore(message, "tool_call_id");
      for (const call of asArray(message.tool_calls) ?? []) {
        restore(asRecord(call), "id");
      }
    }
  } else if (wire === "bedrock:converse") {
    for (const message of chatMessages(params.body)) {
      for (const block of asArray(message.content) ?? []) {
        restore(asRecord(asRecord(block)?.toolUse), "toolUseId");
        restore(asRecord(asRecord(block)?.toolResult), "toolUseId");
      }
    }
  } else if (wire === "gemini:generateContent") {
    for (const content of asArray(asRecord(params.body)?.contents) ?? []) {
      for (const part of asArray(asRecord(content)?.parts) ?? []) {
        restore(asRecord(asRecord(part)?.functionCall), "id");
        restore(asRecord(asRecord(part)?.functionResponse), "id");
      }
    }
  }
  return found;
}

/**
 * Removes session-receipt marks from conversation history before request
 * forwarding. Only message text fields are inspected. Tool arguments, results,
 * reasoning, and instructions are not treated as control data.
 *
 * Stripping is unconditional: receipts must never reach providers or logs,
 * even when OpenAPPA is off. Lineage evidence resolution (a database lookup
 * restricted to the request's caller) happens separately, only with APPA on.
 */
export function stripSessionReceiptsFromRequest(params: {
  family: AppaWireFamily;
  body: unknown;
}): string[] {
  const codes: string[] = [];
  for (const site of historyTextSites(params.family, params.body)) {
    const restored = stripSessionReceipts(site.get());
    site.set(restored.text);
    codes.push(...restored.codes);
  }
  return [...new Set(codes)];
}

/** Resolves stripped receipt codes to caller-owned lineage evidence. */
export async function sessionReceiptEvidence(params: {
  organizationId: string;
  callerId: string;
  codes: string[];
}): Promise<string[]> {
  const unique = [...new Set(params.codes)];
  if (unique.length === 0) return [];
  const owners = await OpenAppaSessionModel.receiptTokenOwners({
    organizationId: params.organizationId,
    tokens: unique,
  });
  const sessionIds: string[] = [];
  for (const code of unique) {
    const owner = owners.get(code);
    if (!owner) {
      logger.debug({ code }, "OpenAPPA ignored an unknown session receipt");
      continue;
    }
    if (owner.callerId !== params.callerId) continue;
    sessionIds.push(clientSessionId(owner.sessionId));
  }
  return sessionIds;
}

/** Prepends one session receipt to the first non-empty model text part. */
export function appendSessionReceiptToResponse(params: {
  family: AppaWireFamily;
  response: unknown;
  code: string;
}): boolean {
  for (const site of responseTextSites(params.family, params.response)) {
    if (!site.get()) continue;
    site.set(appendSessionReceipt(site.get(), params.code));
    return true;
  }
  return false;
}

/**
 * Removes child-trajectory carriers before forwarding requests. Returns only
 * proofs carried as the current conversation's context. A proof nested inside
 * a native child-return notification is transport metadata for that returned
 * value, not lineage evidence for the parent processing the notification.
 */
export function stripChildTrajectoryReceiptsFromRequest(params: {
  family: AppaWireFamily;
  body: unknown;
}): AppaChildTrajectoryReceipt[] {
  const receipts: AppaChildTrajectoryReceipt[] = [];
  for (const site of historyTextSites(params.family, params.body)) {
    const text = site.get();
    const stripped = stripChildTrajectoryReceipts(text);
    site.set(stripped.text);
    if (!isChildReturnEnvelopeSite(site, text)) {
      receipts.push(...stripped.receipts);
    }
  }
  return receipts;
}

/** Prepends one child-trajectory display and proof carrier. */
export function appendChildTrajectoryReceiptToResponse(params: {
  family: AppaWireFamily;
  response: unknown;
  footer: string;
}): boolean {
  for (const site of responseTextSites(params.family, params.response)) {
    if (!site.get()) continue;
    site.set(appendChildTrajectoryReceipt(site.get(), params.footer));
    return true;
  }
  for (const site of responseTextSites(params.family, params.response)) {
    site.set(params.footer);
    return true;
  }
  return false;
}

/**
 * Removes tools from every declaration container, each by its exact wire name
 * and namespace: a namespace member only from the namespace it names, and a
 * tool with no namespace only outside every namespace.
 */
export function stripAppaTools(params: {
  body: unknown;
  tools: readonly DeclaredToolSpelling[];
}): void {
  if (params.tools.length === 0) return;
  const isStripped = (tool: unknown, namespace: string | undefined) => {
    const name = declaredToolName(tool);
    return params.tools.some(
      (spelling) => spelling.name === name && spelling.namespace === namespace,
    );
  };
  for (const { holder, key } of toolContainers(params.body)) {
    // Gemini accepts a lone tool object where it accepts a list of them; the
    // filter below needs the list.
    if (asRecord(holder[key])) holder[key] = [holder[key]];
    const declared = holder[key];
    if (!Array.isArray(declared)) continue;
    holder[key] = declared.filter((tool) => {
      const group = groupedMembers(tool);
      if (group) {
        // A group keeps its other tools; only the named one leaves.
        const namespace = groupNamespace(tool);
        group.holder[group.key] = group.members.filter(
          (member) => !isStripped(member, namespace),
        );
        return true;
      }
      return !isStripped(tool, undefined);
    });
  }
}

/**
 * Every tool this request declares, in every container and namespace.
 *
 * Codex groups an MCP server's tools under one `namespace` declaration and
 * calls a member by its own name, so a namespace's members are returned under
 * those names, each with the namespace that declares it: the name alone does
 * not say which server a member belongs to.
 */

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
 * two kinds of Responses input item: `additional_tools`, where Codex declares
 * the tools of the models it drives over the lite Responses wire, and
 * `tool_search_output`, where a client-run tool search hands the model the
 * tools it loaded. On a model with tool search, Codex declares only the
 * search and no MCP tool inline, so the tools the model calls are declared
 * there and nowhere else.
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
      if (
        entry?.type === "additional_tools" ||
        entry?.type === "tool_search_output"
      )
        containers.push({ holder: entry, key: "tools" });
    }
  return containers;
}

/**
 * The tools a container holds, read without changing its shape: Gemini
 * accepts a lone tool object where it accepts a list of them.
 */
function containerTools(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return asRecord(value) ? [value] : [];
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
 * The client session this request belongs to, as the client itself reports it
 * through generic wire fields.
 *
 * A session id cannot come from static client configuration: it changes every
 * time a person starts a new session, and no external client has logic to mint
 * one for us. Client-specific signals - Claude Code's session header, Codex's
 * turn metadata, OpenCode's session headers - are extracted by the client
 * adapters (`appa-plugin-archestra/adapters`), which run before these generic
 * fallbacks. An explicit `X-Appa-Session-ID` still wins where it is sent
 * (Chat, the qualification harness, any caller that manages roots
 * deliberately).
 *
 * What each family offers generically, and why:
 *  - anthropic:messages - Claude clients repeat the session uuid inside
 *    `metadata.user_id` (a JSON blob of device/account/session), which is
 *    per-session and survives a restart of the same session.
 *  - openai:responses / chatCompletions - the legacy OpenCode
 *    `x-opencode-session` header, then request fields that are stable across a
 *    conversation: `prompt_cache_key` (OpenAI's own per-conversation cache
 *    partition), an explicit `metadata.session_id`, then `conversation`.
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
    const userId = field(asRecord(body?.metadata)?.user_id);
    const metadataSession = userId
      ? (parseClaudeMetadataSessionId(userId) ?? userId)
      : undefined;
    if (metadataSession) {
      // Claude session ID from user_id metadata.
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

/** A declared tool as the client spells it: its name, and the Codex namespace it sits in. */
export type DeclaredToolSpelling = { name: string; namespace?: string };

/**
 * Every tool this request declares, in every container and group, in order.
 *
 * Reads `tools`, `additional_tools`, Bedrock Converse's `toolConfig.tools`
 * and the Responses `additional_tools` and `tool_search_output` input items.
 * A Codex namespace and a Gemini `functionDeclarations` entry stand for their
 * members, never for themselves: Codex calls a namespace member by its own
 * name, in the namespace it was declared in, which each member entry carries.
 * Reading changes nothing, so a lone Gemini tool object stays an object.
 */
export function declaredToolEntries(body: unknown): DeclaredToolEntry[] {
  const entries: DeclaredToolEntry[] = [];
  for (const { holder, key } of toolContainers(body)) {
    for (const tool of containerTools(holder[key])) {
      const group = groupedMembers(tool);
      if (!group) {
        entries.push(declaredToolEntry(tool));
        continue;
      }
      const namespace = groupNamespace(tool);
      for (const member of group.members) {
        entries.push(declaredToolEntry(member, namespace));
      }
    }
  }
  return entries;
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

/**
 * Where the other chat wires carry a call's id, for putting the provider's
 * back: in an APPA family's shape (Cohere and native Ollama name calls the
 * way Chat Completions does; Azure Responses is the Responses wire), or in
 * their own.
 */
const OTHER_STAMP_WIRES: Partial<
  Record<
    SupportedProviderDiscriminator,
    AppaWireFamily | "bedrock:converse" | "gemini:generateContent"
  >
> = {
  "azure:responses": "openai:responses",
  "bedrock:converse": "bedrock:converse",
  "cohere:chat": "openai:chatCompletions",
  "gemini:generateContent": "gemini:generateContent",
  "ollama-native:chat": "openai:chatCompletions",
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

type DeclaredToolEntry = {
  /** The declaration: a Codex namespace member or a Gemini `functionDeclarations` member when grouped. */
  tool: unknown;
  /**
   * The object that carries the tool's `name` and `description`: the tool
   * itself, or its `function`, `custom` or `toolSpec`. Absent when nameless.
   */
  holder?: Record<string, unknown>;
  /** {@link declaredToolName} of the declaration. */
  name?: string;
  /** `name` of the enclosing Codex `namespace` declaration. Never set for Gemini groups. */
  namespace?: string;
};

function declaredToolEntry(
  tool: unknown,
  namespace?: string,
): DeclaredToolEntry {
  const holder = declarationHolder(tool);
  const name = declaredToolName(tool);
  return {
    tool,
    ...(holder ? { holder } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

/**
 * The wire name of a declared tool: Anthropic, Responses and Gemini name the
 * tool itself; Chat Completions nests it under `function`, or under `custom`
 * for a free-form tool; Bedrock Converse under `toolSpec`.
 */
function declaredToolName(tool: unknown): string | undefined {
  const name = declarationHolder(tool)?.name;
  return typeof name === "string" ? name : undefined;
}

/** The object a declaration keeps its name and description on, per {@link declaredToolName}. */
function declarationHolder(tool: unknown): Record<string, unknown> | undefined {
  const record = asRecord(tool);
  if (!record) return undefined;
  if (typeof record.name === "string") return record;
  for (const nested of [record.function, record.custom, record.toolSpec]) {
    const inner = asRecord(nested);
    if (typeof inner?.name === "string") return inner;
  }
  return undefined;
}

/**
 * The namespace a group's members are declared, and called, in: a Codex
 * namespace's own name. A Gemini `functionDeclarations` entry has none, and
 * an empty name is none, as it is on a call.
 */
function groupNamespace(tool: unknown): string | undefined {
  if (!namespaceMembers(tool)) return undefined;
  const name = asRecord(tool)?.name;
  return typeof name === "string" && name !== "" ? name : undefined;
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

/** The tool names every APPA wire's provider accepts in a request. */
const PROVIDER_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

type ToolCallSite = {
  id: string;
  name: string;
  /** The namespace the call names (Codex Responses). */
  namespace?: string;
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
  match: (name: string, namespace?: string) => boolean;
}): ToolCallSite[] {
  const found: ToolCallSite[] = [];
  // Claimed by name and namespace alone. The client echoes the name the proxy
  // sent, and a tool of its own that happens to take a `ruling` argument must
  // never be read as a notice — nor rejected as a malformed one.
  const claim = (name: unknown, namespace?: string): boolean =>
    typeof name === "string" && params.match(name, namespace);

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
      const namespace =
        typeof item.namespace === "string" && item.namespace !== ""
          ? item.namespace
          : undefined;
      if (!claim(item.name, namespace) || typeof id !== "string") continue;
      found.push({
        id,
        name: item.name as string,
        ...(namespace ? { namespace } : {}),
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

export function responsesItems(body: unknown): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const item of asArray(asRecord(body)?.input) ?? []) {
    const record = asRecord(item);
    if (record) items.push(record);
  }
  return items;
}

export function chatMessages(body: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const message of asArray(asRecord(body)?.messages) ?? []) {
    const record = asRecord(message);
    if (record) messages.push(record);
  }
  return messages;
}

type TextSite = {
  get: () => string;
  set: (text: string) => void;
  role?: "user" | "assistant";
};

/**
 * Text that a client may carry between turns. This accepts only the documented
 * message containers for each wire, rather than walking arbitrary nested data.
 */
function historyTextSites(family: AppaWireFamily, body: unknown): TextSite[] {
  const sites: TextSite[] = [];
  const addContent = (message: Record<string, unknown>) => {
    const role = message.role as "user" | "assistant";
    if (typeof message.content === "string") {
      sites.push({
        role,
        get: () => message.content as string,
        set: (text) => {
          message.content = text;
        },
      });
      return;
    }
    for (const part of asArray(message.content) ?? []) {
      const record = asRecord(part);
      if (
        !record ||
        typeof record.text !== "string" ||
        !HISTORY_TEXT_PART_TYPES.has(record.type as string)
      )
        continue;
      sites.push({
        role,
        get: () => record.text as string,
        set: (text) => {
          record.text = text;
        },
      });
    }
  };

  if (family === "openai:responses") {
    const record = asRecord(body);
    if (typeof record?.input === "string") {
      sites.push({
        role: "user",
        get: () => record.input as string,
        set: (text) => {
          record.input = text;
        },
      });
      return sites;
    }
    for (const item of responsesItems(body)) {
      if (
        (item.type !== undefined && item.type !== "message") ||
        (item.role !== "user" && item.role !== "assistant")
      )
        continue;
      addContent(item);
    }
    return sites;
  }

  for (const message of chatMessages(body)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    addContent(message);
  }
  return sites;
}

function isChildReturnEnvelopeSite(site: TextSite, text: string): boolean {
  if (site.role !== "user") return false;
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("<task-notification>") &&
      trimmed.endsWith("</task-notification>")) ||
    (trimmed.startsWith("<subagent_notification>") &&
      trimmed.endsWith("</subagent_notification>"))
  );
}

/** Text parts the proxy may return as model-visible assistant content. */
function responseTextSites(
  family: AppaWireFamily,
  response: unknown,
): TextSite[] {
  const sites: TextSite[] = [];
  const responseRecord = asRecord(response);
  if (!responseRecord) return sites;

  if (family === "anthropic:messages") {
    const content = asArray(responseRecord.content);
    if (Array.isArray(content)) {
      for (const part of content) {
        const record = asRecord(part);
        if (record?.type !== "text" || typeof record.text !== "string")
          continue;
        sites.push({
          get: () => record.text as string,
          set: (text) => {
            record.text = text;
          },
        });
      }
      if (sites.length === 0) {
        sites.push({
          get: () => "",
          set: (text) => {
            content.unshift({ type: "text", text });
          },
        });
      }
    }
    return sites;
  }

  if (family === "openai:responses") {
    const output = asArray(responseRecord.output);
    if (Array.isArray(output)) {
      for (const item of output) {
        const message = asRecord(item);
        if (message?.type !== "message" || message.role !== "assistant")
          continue;
        for (const part of asArray(message.content) ?? []) {
          const record = asRecord(part);
          if (record?.type !== "output_text" || typeof record.text !== "string")
            continue;
          sites.push({
            get: () => record.text as string,
            set: (text) => {
              record.text = text;
            },
          });
        }
      }
      if (sites.length === 0) {
        sites.push({
          get: () => "",
          set: (text) => {
            output.unshift({
              id: `msg_${Math.random().toString(36).slice(2, 10)}`,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            });
          },
        });
      }
    }
    return sites;
  }

  for (const choice of asArray(responseRecord.choices) ?? []) {
    const message = asRecord(asRecord(choice)?.message);
    if (!message) continue;
    if (typeof message.content === "string") {
      sites.push({
        get: () => message.content as string,
        set: (text) => {
          message.content = text;
        },
      });
      continue;
    }
    if (message.content === null || message.content === undefined) {
      sites.push({
        get: () => "",
        set: (text) => {
          message.content = text;
        },
      });
      continue;
    }
    for (const part of asArray(message.content) ?? []) {
      const record = asRecord(part);
      if (record?.type !== "text" || typeof record.text !== "string") continue;
      sites.push({
        get: () => record.text as string,
        set: (text) => {
          record.text = text;
        },
      });
    }
  }
  return sites;
}

const HISTORY_TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
