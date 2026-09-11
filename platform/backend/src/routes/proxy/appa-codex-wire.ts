/**
 * Stateless Codex Responses wire transforms for the APPA proxy boundary.
 *
 * The caller owns all identifier allocation and persistence. This module only
 * applies the aliases passed to one call and returns correlation records that
 * can be written to that ledger. It deliberately does not interpret Code Mode
 * JavaScript or decrypt encrypted tool arguments.
 */

export type CodexWireObject = Record<string, unknown>;

export interface CodexToolReference {
  namespace?: string;
  name: string;
  kind: "function" | "custom";
}

export interface CodexIdAlias {
  clientId: string;
  proxyId: string;
}

/** A logical task is the parent-ledger identity; the client path is Codex's path. */
export interface CodexTaskAlias {
  logicalTaskPath: string;
  clientTaskPath: string;
  wireTaskName?: string;
  logicalAgentId?: string;
  clientAgentId?: string;
}

export interface CodexCallAlias extends CodexIdAlias {
  namespace?: string;
  name?: string;
  kind?: "function" | "custom";
}

export interface CodexWireAliases {
  callIds: readonly CodexCallAlias[];
  itemIds: readonly CodexIdAlias[];
  tasks: readonly CodexTaskAlias[];
}

/**
 * IDs and task handles allocated by the parent before an upstream response is
 * admitted. `provider*` optionally assert IDs supplied by Codex; `client*` are
 * the parent-owned IDs exposed after rewriting. `outputIndex` is zero-based in
 * `response.output` and is required whenever either provider ID is absent.
 */
export interface CodexResponseAllocation {
  outputIndex?: number;
  providerCallId?: string;
  providerItemId?: string;
  clientCallId: string;
  clientItemId: string;
  taskAlias?: CodexTaskAlias;
}

export interface CodexToolCallCorrelation {
  kind: "tool_call";
  namespace?: string;
  name: string;
  toolKind: "function" | "custom";
  /** The ID Codex supplied, if any. It is never synthesized by this codec. */
  providerCallId?: string;
  providerItemId?: string;
  providerCallIdPresent: boolean;
  providerItemIdPresent: boolean;
  /** Parent-allocated, client-visible IDs written into the rewritten response. */
  clientCallId: string;
  clientItemId: string;
  taskAlias?: CodexTaskAlias;
}

export interface CodexV1SpawnResult {
  clientCallId: string;
  proxyCallId: string;
  clientAgentId: string;
}

export interface CodexChildThreadBinding {
  clientParentThreadId: string;
  clientThreadId: string;
  logicalParentThreadId: string;
  logicalThreadId: string;
}

export interface CodexNormalizedRequest {
  body: CodexWireObject;
  headers: Record<string, string>;
}

export interface CodexRewrittenResponse {
  response: CodexWireObject;
  correlations: CodexToolCallCorrelation[];
}

export interface CodexRewrittenRequest {
  request: CodexWireObject;
  v1SpawnResults: CodexV1SpawnResult[];
}

/** A terminal client-side search record is discovery bookkeeping, not a tool call. */
export function isCodexToolSearchCall(
  item: unknown,
): item is CodexWireObject & {
  id: string;
  call_id: string;
  type: "tool_search_call";
  execution: "client";
} {
  return (
    isObject(item) &&
    item.type === "tool_search_call" &&
    item.execution === "client" &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.call_id === "string" &&
    item.call_id.length > 0 &&
    "arguments" in item
  );
}

/** Tool-search results are accepted only through the issued-call projection. */
export function isCodexToolSearchOutput(
  item: unknown,
): item is CodexWireObject & { call_id: string; type: "tool_search_output" } {
  return (
    isObject(item) &&
    item.type === "tool_search_output" &&
    typeof item.call_id === "string" &&
    item.call_id.length > 0
  );
}

/**
 * Turns a Code Mode `additional_tools` packet into native Responses tools.
 * `functions.exec` is withheld: this boundary supports direct native calls,
 * not arbitrary JavaScript program execution.
 */
export function normalizeCodexRequestToNativeTools(params: {
  body: CodexWireObject;
  headers?: Record<string, string | undefined>;
}): CodexNormalizedRequest {
  const body = cloneObject(params.body);
  const input = Array.isArray(body.input) ? body.input : [];
  const additionalTools = input.filter(isAdditionalToolsItem);
  const retainedInput = input.filter((item) => !isAdditionalToolsItem(item));
  const movedTools = additionalTools.flatMap((item) =>
    asObjectArray(item.tools),
  );
  const existingTools = asObjectArray(body.tools);
  const tools = [...existingTools, ...movedTools].filter(
    (tool) => !isCodeModeExecTool(tool),
  );

  if (additionalTools.length > 0) {
    body.input = retainedInput;
  }
  // Also sanitize already-top-level declarations; no Code Mode program is
  // exposed merely because the request did not carry `additional_tools`.
  body.tools = tools;

  // Native direct calls are not compatible with the Responses Lite transport.
  return {
    body,
    headers: omitHeader(
      params.headers ?? {},
      "x-openai-internal-codex-responses-lite",
    ),
  };
}

/**
 * Rewrites an upstream Codex Responses payload to parent-owned client IDs. No
 * provider ID is generated: missing provider IDs require an output-position
 * allocation and remain absent in the returned correlation record.
 */
export function rewriteCodexResponseToProxy(params: {
  response: CodexWireObject;
  allocations: readonly CodexResponseAllocation[];
  knownTools: readonly CodexToolReference[];
}): CodexRewrittenResponse {
  validateAllocations(params.allocations);
  const response = cloneObject(params.response);
  const output = asObjectArray(response.output);
  const correlations: CodexToolCallCorrelation[] = [];
  const seenCallIds = new Set<string>();
  const seenItemIds = new Set<string>();

  for (const [outputIndex, item] of output.entries()) {
    if (!isToolCall(item)) continue;

    const providerCallId = optionalNonEmptyString(item, "call_id", "tool call");
    const providerItemId = optionalNonEmptyString(item, "id", "tool call");
    rejectDuplicateId({
      seen: seenCallIds,
      value: providerCallId,
      label: "Codex call_id",
    });
    rejectDuplicateId({
      seen: seenItemIds,
      value: providerItemId,
      label: "Codex item id",
    });

    const namespace = optionalString(item, "namespace", "tool call");
    const name = requiredString(item, "name", "tool call");
    const toolKind = item.type === "function_call" ? "function" : "custom";
    assertKnownTool({ namespace, name, kind: toolKind }, params.knownTools);
    const allocation = findResponseAllocation({
      allocations: params.allocations,
      outputIndex,
      providerCallId,
      providerItemId,
    });
    if (!allocation) {
      throw new Error(
        `Missing client ID allocation for Codex output index ${outputIndex}`,
      );
    }

    if (allocation.taskAlias) {
      rewriteSpawnTaskName({ item, taskAlias: allocation.taskAlias });
    }
    item.call_id = allocation.clientCallId;
    item.id = allocation.clientItemId;
    correlations.push({
      kind: "tool_call",
      namespace,
      name,
      toolKind,
      ...(providerCallId ? { providerCallId } : {}),
      ...(providerItemId ? { providerItemId } : {}),
      providerCallIdPresent: providerCallId !== undefined,
      providerItemIdPresent: providerItemId !== undefined,
      clientCallId: allocation.clientCallId,
      clientItemId: allocation.clientItemId,
      ...(allocation.taskAlias ? { taskAlias: allocation.taskAlias } : {}),
    });
  }

  return { response, correlations };
}

/**
 * Restores proxy IDs and logical task identities to Codex client values before
 * forwarding a parent request upstream. Only protocol identifier fields are
 * changed; message content and encrypted fields are copied byte-for-byte.
 */
export function rewriteCodexProxyRequestToClient(params: {
  request: CodexWireObject;
  aliases: CodexWireAliases;
  threadBinding?: CodexChildThreadBinding;
}): CodexRewrittenRequest {
  validateAliases(params.aliases);
  const request = cloneObject(params.request);
  rewriteRequestIds({
    request,
    aliases: params.aliases,
    direction: "toClient",
  });
  rewriteRequestTaskMetadata({
    request,
    aliases: params.aliases,
    direction: "toClient",
    threadBinding: params.threadBinding,
  });
  return { request, v1SpawnResults: [] };
}

/**
 * Admits a client-originated child request into the parent namespace. A child
 * thread header is accepted only with the parent-ledger binding supplied here.
 */
export function rewriteCodexClientRequestToProxy(params: {
  request: CodexWireObject;
  aliases: CodexWireAliases;
  threadBinding?: CodexChildThreadBinding;
}): CodexRewrittenRequest {
  validateAliases(params.aliases);
  const request = cloneObject(params.request);
  rewriteRequestIds({ request, aliases: params.aliases, direction: "toProxy" });
  rewriteRequestTaskMetadata({
    request,
    aliases: params.aliases,
    direction: "toProxy",
    threadBinding: params.threadBinding,
  });
  return {
    request,
    v1SpawnResults: collectV1SpawnResults({ request, aliases: params.aliases }),
  };
}

/** Context eligibility only; callers still own policy and permission decisions. */
export function isCodexRequestUserInputEligible(params: {
  isRootRegisteredHandler: boolean;
  mode: string | undefined;
  defaultModeRequestUserInput: boolean;
}): boolean {
  return (
    params.isRootRegisteredHandler &&
    (params.mode === "plan" || params.defaultModeRequestUserInput)
  );
}

/** Returns the native declaration shape without deciding whether to expose it. */
export function buildCodexRequestUserInputTool(): CodexWireObject {
  return {
    type: "function",
    name: "request_user_input",
    description: "Ask the user for clarification before continuing.",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              options: { type: "array", items: { type: "string" } },
            },
            required: ["id", "question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  };
}

// === Internal helpers ===

type RewriteDirection = "toClient" | "toProxy";

function rewriteRequestIds(params: {
  request: CodexWireObject;
  aliases: CodexWireAliases;
  direction: RewriteDirection;
}): void {
  for (const item of asObjectArray(params.request.input)) {
    if (isToolCall(item) || isToolOutput(item)) {
      rewriteIdField({
        item,
        field: "call_id",
        aliases: params.aliases.callIds,
        direction: params.direction,
      });
    }
    if (isToolCall(item)) {
      rewriteIdField({
        item,
        field: "id",
        aliases: params.aliases.itemIds,
        direction: params.direction,
      });
      rewriteCollaborationArguments({
        item,
        aliases: params.aliases,
        direction: params.direction,
      });
    }
  }
}

function rewriteRequestTaskMetadata(params: {
  request: CodexWireObject;
  aliases: CodexWireAliases;
  direction: RewriteDirection;
  threadBinding?: CodexChildThreadBinding;
}): void {
  const headers = isObject(params.request.headers)
    ? (params.request.headers as CodexWireObject)
    : undefined;
  const metadata = headers
    ? parseMetadataHeader(headers["x-codex-turn-metadata"])
    : undefined;
  const parentThreadHeader = headers?.["x-codex-parent-thread-id"];

  if (parentThreadHeader !== undefined && !params.threadBinding) {
    throw new Error(
      "Codex child request requires a parent-ledger thread binding",
    );
  }
  if (params.threadBinding && headers && metadata) {
    rewriteThreadBinding({
      headers,
      metadata,
      binding: params.threadBinding,
      direction: params.direction,
    });
  }
  if (metadata) {
    rewriteTaskField({
      target: metadata,
      field: "agent_name",
      aliases: params.aliases.tasks,
      direction: params.direction,
    });
    writeMetadataHeader(headers as CodexWireObject, metadata);
  }

  for (const item of asObjectArray(params.request.input)) {
    if (item.type !== "agent_message") continue;
    rewriteTaskField({
      target: item,
      field: "author",
      aliases: params.aliases.tasks,
      direction: params.direction,
    });
    rewriteTaskField({
      target: item,
      field: "recipient",
      aliases: params.aliases.tasks,
      direction: params.direction,
    });
  }
}

function rewriteThreadBinding(params: {
  headers: CodexWireObject;
  metadata: CodexWireObject;
  binding: CodexChildThreadBinding;
  direction: RewriteDirection;
}): void {
  const from =
    params.direction === "toProxy"
      ? {
          parent: params.binding.clientParentThreadId,
          thread: params.binding.clientThreadId,
          replacementParent: params.binding.logicalParentThreadId,
          replacementThread: params.binding.logicalThreadId,
        }
      : {
          parent: params.binding.logicalParentThreadId,
          thread: params.binding.logicalThreadId,
          replacementParent: params.binding.clientParentThreadId,
          replacementThread: params.binding.clientThreadId,
        };
  if (params.headers["x-codex-parent-thread-id"] !== from.parent) {
    throw new Error(
      "Codex child request parent thread does not match ledger binding",
    );
  }
  if (params.headers["thread-id"] !== from.thread) {
    throw new Error("Codex child request thread does not match ledger binding");
  }
  if (
    params.metadata.parent_thread_id !== from.parent ||
    params.metadata.thread_id !== from.thread
  ) {
    throw new Error(
      "Codex child metadata does not match ledger thread binding",
    );
  }
  params.headers["x-codex-parent-thread-id"] = from.replacementParent;
  params.headers["thread-id"] = from.replacementThread;
  params.metadata.parent_thread_id = from.replacementParent;
  params.metadata.thread_id = from.replacementThread;
}

function rewriteCollaborationArguments(params: {
  item: CodexWireObject;
  aliases: CodexWireAliases;
  direction: RewriteDirection;
}): void {
  if (params.item.namespace !== "collaboration") return;
  const name = optionalString(params.item, "name", "tool call");
  if (!name || !COLLABORATION_TASK_ARGUMENTS.has(name)) return;
  const argumentsObject = parseToolArguments(params.item);
  for (const field of ["task_name", "agent_name", "recipient"] as const) {
    rewriteTaskField({
      target: argumentsObject,
      field,
      aliases: params.aliases.tasks,
      direction: params.direction,
    });
  }
  params.item.arguments = JSON.stringify(argumentsObject);
}

function rewriteSpawnTaskName(params: {
  item: CodexWireObject;
  taskAlias: CodexTaskAlias;
}): void {
  if (
    params.item.namespace !== "collaboration" ||
    params.item.name !== "spawn_agent"
  ) {
    return;
  }
  if (!params.taskAlias.wireTaskName) {
    throw new Error(
      "Codex spawn allocation requires a proxy-generated wireTaskName",
    );
  }
  const argumentsObject = parseToolArguments(params.item);
  requiredString(argumentsObject, "task_name", "spawn_agent arguments");
  // The message may be encrypted. Validate its wire type but never inspect it.
  requiredString(argumentsObject, "message", "spawn_agent arguments");
  argumentsObject.task_name = params.taskAlias.wireTaskName;
  params.item.arguments = JSON.stringify(argumentsObject);
}

function collectV1SpawnResults(params: {
  request: CodexWireObject;
  aliases: CodexWireAliases;
}): CodexV1SpawnResult[] {
  const results: CodexV1SpawnResult[] = [];
  for (const item of asObjectArray(params.request.input)) {
    if (!isToolOutput(item)) continue;
    const proxyCallId = requiredString(item, "call_id", "tool output");
    const callAlias = params.aliases.callIds.find(
      (alias) => alias.proxyId === proxyCallId,
    );
    if (
      callAlias?.namespace !== "collaboration" ||
      callAlias.name !== "spawn_agent"
    ) {
      continue;
    }
    const output = parseJsonObject(item.output);
    const clientAgentId = optionalString(
      output,
      "agent_id",
      "spawn_agent output",
    );
    if (clientAgentId) {
      results.push({
        clientCallId: callAlias.clientId,
        proxyCallId,
        clientAgentId,
      });
    }
  }
  return results;
}

function rewriteIdField(params: {
  item: CodexWireObject;
  field: "call_id" | "id";
  aliases: readonly CodexIdAlias[];
  direction: RewriteDirection;
}): void {
  const value = optionalString(params.item, params.field, "wire item");
  if (!value) return;
  const alias = params.aliases.find((candidate) =>
    params.direction === "toClient"
      ? candidate.proxyId === value
      : candidate.clientId === value,
  );
  if (!alias) {
    throw new Error(`Unknown proxy alias for ${params.field}: ${value}`);
  }
  params.item[params.field] =
    params.direction === "toClient" ? alias.clientId : alias.proxyId;
}

function rewriteTaskField(params: {
  target: CodexWireObject;
  field: string;
  aliases: readonly CodexTaskAlias[];
  direction: RewriteDirection;
}): void {
  const value = optionalString(params.target, params.field, "task metadata");
  if (!value) return;
  const alias = params.aliases.find((candidate) =>
    params.direction === "toClient"
      ? candidate.logicalTaskPath === value
      : candidate.clientTaskPath === value,
  );
  if (!alias) return;
  params.target[params.field] =
    params.direction === "toClient"
      ? alias.clientTaskPath
      : alias.logicalTaskPath;
}

function validateAliases(aliases: CodexWireAliases): void {
  validateIdAliases(aliases.callIds, "call");
  validateIdAliases(aliases.itemIds, "item");
  assertUnique(
    aliases.tasks.map((alias) => alias.logicalTaskPath),
    "logical task path",
  );
  assertUnique(
    aliases.tasks.map((alias) => alias.clientTaskPath),
    "client task path",
  );
}

function validateAllocations(
  allocations: readonly CodexResponseAllocation[],
): void {
  assertUnique(
    allocations.map((allocation) => allocation.clientCallId),
    "allocated client-visible call ID",
  );
  assertUnique(
    allocations.map((allocation) => allocation.clientItemId),
    "allocated client-visible item ID",
  );
  assertOptionalUnique(
    allocations.map((allocation) => allocation.outputIndex),
    "allocated output index",
  );
  assertOptionalUnique(
    allocations.map((allocation) => allocation.providerCallId),
    "allocated provider call ID",
  );
  assertOptionalUnique(
    allocations.map((allocation) => allocation.providerItemId),
    "allocated provider item ID",
  );
  for (const allocation of allocations) {
    if (
      (allocation.providerCallId === undefined ||
        allocation.providerItemId === undefined) &&
      allocation.outputIndex === undefined
    ) {
      throw new Error(
        "Allocation without both provider IDs requires an outputIndex",
      );
    }
    if (
      allocation.outputIndex !== undefined &&
      (!Number.isInteger(allocation.outputIndex) || allocation.outputIndex < 0)
    ) {
      throw new Error("Allocation outputIndex must be a non-negative integer");
    }
  }
}

function validateIdAliases(
  aliases: readonly CodexIdAlias[],
  label: string,
): void {
  assertUnique(
    aliases.map((alias) => alias.clientId),
    `client ${label} ID`,
  );
  assertUnique(
    aliases.map((alias) => alias.proxyId),
    `proxy ${label} ID`,
  );
}

function assertKnownTool(
  candidate: CodexToolReference,
  knownTools: readonly CodexToolReference[],
): void {
  const found = knownTools.some(
    (tool) =>
      tool.namespace === candidate.namespace &&
      tool.name === candidate.name &&
      tool.kind === candidate.kind,
  );
  if (!found) {
    throw new Error(
      `Unknown Codex tool ${candidate.namespace ? `${candidate.namespace}.` : ""}${candidate.name} (${candidate.kind})`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) {
      throw new Error(`Duplicate or empty ${label}: ${value || "<empty>"}`);
    }
    seen.add(value);
  }
}

function assertOptionalUnique(
  values: readonly (string | number | undefined)[],
  label: string,
): void {
  const seen = new Set<string | number>();
  for (const value of values) {
    if (value === undefined) continue;
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function findResponseAllocation(params: {
  allocations: readonly CodexResponseAllocation[];
  outputIndex: number;
  providerCallId: string | undefined;
  providerItemId: string | undefined;
}): CodexResponseAllocation | undefined {
  const hasBothProviderIds =
    params.providerCallId !== undefined && params.providerItemId !== undefined;
  if (hasBothProviderIds) {
    const byProviderIds = params.allocations.find(
      (allocation) =>
        allocation.providerCallId === params.providerCallId &&
        allocation.providerItemId === params.providerItemId,
    );
    if (byProviderIds) return byProviderIds;
  }
  return params.allocations.find(
    (allocation) => allocation.outputIndex === params.outputIndex,
  );
}

function rejectDuplicateId(params: {
  seen: Set<string>;
  value: string | undefined;
  label: string;
}): void {
  if (params.value === undefined) return;
  if (params.seen.has(params.value)) {
    throw new Error(`Duplicate ${params.label}: ${params.value}`);
  }
  params.seen.add(params.value);
}

function parseToolArguments(item: CodexWireObject): CodexWireObject {
  return parseJsonObject(requiredString(item, "arguments", "tool call"));
}

function parseJsonObject(value: unknown): CodexWireObject {
  if (isObject(value)) return value;
  if (typeof value !== "string") {
    throw new Error("Codex tool arguments must be a JSON object string");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Codex tool arguments are not valid JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("Codex tool arguments must be a JSON object");
  }
  return parsed;
}

function requiredString(
  value: CodexWireObject,
  field: string,
  label: string,
): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Codex ${label} requires non-empty ${field}`);
  }
  return candidate;
}

function optionalString(
  value: CodexWireObject,
  field: string,
  label: string,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") {
    throw new Error(`Codex ${label} field ${field} must be a string`);
  }
  return candidate;
}

function optionalNonEmptyString(
  value: CodexWireObject,
  field: string,
  label: string,
): string | undefined {
  const result = optionalString(value, field, label);
  if (result === "") {
    throw new Error(`Codex ${label} field ${field} must not be empty`);
  }
  return result;
}

function parseMetadataHeader(value: unknown): CodexWireObject | undefined {
  if (value === undefined) return undefined;
  if (isObject(value)) return value;
  return parseJsonObject(value);
}

function writeMetadataHeader(
  headers: CodexWireObject,
  metadata: CodexWireObject,
): void {
  const current = headers["x-codex-turn-metadata"];
  headers["x-codex-turn-metadata"] =
    typeof current === "string" ? JSON.stringify(metadata) : metadata;
}

function isAdditionalToolsItem(value: unknown): value is CodexWireObject {
  return isObject(value) && value.type === "additional_tools";
}

function isToolCall(value: CodexWireObject): boolean {
  return value.type === "function_call" || value.type === "custom_tool_call";
}

function isToolOutput(value: CodexWireObject): boolean {
  return (
    value.type === "function_call_output" ||
    value.type === "custom_tool_call_output"
  );
}

function isCodeModeExecTool(tool: CodexWireObject): boolean {
  if (tool.type === "namespace" && tool.name === "functions") {
    tool.tools = asObjectArray(tool.tools).filter(
      (member) => !(member.type === "custom" && member.name === "exec"),
    );
  }
  return tool.type === "custom" && tool.name === "exec";
}

function asObjectArray(value: unknown): CodexWireObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function isObject(value: unknown): value is CodexWireObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneObject(value: CodexWireObject): CodexWireObject {
  return structuredClone(value);
}

function omitHeader(
  headers: Record<string, string | undefined>,
  headerName: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== headerName && value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

const COLLABORATION_TASK_ARGUMENTS = new Set([
  "followup_task",
  "interrupt_agent",
  "send_message",
  "spawn_agent",
  "wait_agent",
]);
