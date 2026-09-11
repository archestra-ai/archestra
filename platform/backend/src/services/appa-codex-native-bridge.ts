/** Native Codex direct-tool registration and legacy Code Mode discovery. */
import { createHash, randomUUID } from "node:crypto";
import { toMcpClientServerName } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { AgentModel } from "@/models";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type {
  CodexToolReference,
  CodexWireObject,
} from "@/routes/proxy/appa-codex-wire";
import {
  isCodexToolSearchCall,
  isCodexToolSearchOutput,
  normalizeCodexRequestToNativeTools,
} from "@/routes/proxy/appa-codex-wire";
import type { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import {
  APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM,
  AppaControlFramePayloadSchema,
} from "@/types/appa-proxy-wire";

const NATIVE_TOOL_DESCRIPTIONS: Record<string, string> = {
  apply_patch: "Apply a patch in the local workspace.",
  exec_command: "Run a command in the local workspace.",
  view_image: "Inspect an image in the local workspace.",
  write_stdin: "Write input to a running local process.",
};

type NativeCodexDialect = "code-mode" | "standard-responses";

export function isNativeCodexCodeModeRequest(
  body: unknown,
): body is CodexWireObject {
  return isObject(body) && nativeCodexDialect(body) !== undefined;
}

export function isNativeCodexCompactionV2(
  request: unknown,
): request is CodexWireObject {
  return (
    isObject(request) &&
    asObjects(request.input).some((item) => item.type === "compaction_trigger")
  );
}

/**
 * Produces the one fixed legacy Code Mode control call. Standard Responses
 * clients register the same direct tools from their declared manifest instead.
 */
export async function createNativeCodexBootstrap(params: {
  session: AppaProxyHookSession;
  request: CodexWireObject;
}): Promise<CodexWireObject> {
  const scope = params.session.getNativeWireScope();
  const callId = `call_appa_${randomUUID().replaceAll("-", "")}`;
  const itemId = `ctc_appa_${randomUUID().replaceAll("-", "")}`;
  const responseId = `resp_appa_${randomUUID().replaceAll("-", "")}`;
  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: typeof params.request.model === "string" ? params.request.model : "",
    status: "completed",
    output: [
      {
        id: itemId,
        type: "custom_tool_call",
        call_id: callId,
        namespace: "functions",
        name: "exec",
        input: APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM,
      },
    ],
  } satisfies CodexWireObject;
  const frame = await AppaProxyWireModel.createFrame({
    ...scope,
    kind: "model_response",
    protocol: "codex-native-bootstrap/v1",
    requestHash: hash(params.request),
    idempotencyKey: `codex-native-bootstrap:${scope.turnId}`,
    payload: response,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  await AppaProxyWireModel.addAliases({
    ...scope,
    frameId: frame.id,
    aliases: [
      {
        kind: "call",
        position: 0,
        wireId: callId,
        metadata: {
          purpose: "codex_native_registry_bootstrap",
          namespace: "functions",
          name: "exec",
          kind: "custom",
          program: APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM,
          responseId,
        },
      },
    ],
  });
  await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
  await AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id });
  return response;
}

/** Stock Codex accepts completed output items without incremental argument deltas. */
export function nativeCodexBootstrapSse(response: CodexWireObject): string {
  const output = asObjects(response.output);
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: { ...response, status: "in_progress", output: [] },
    },
    ...output.map((item, output_index) => ({
      type: "response.output_item.done",
      sequence_number: output_index + 1,
      output_index,
      item,
    })),
    {
      type: "response.completed",
      sequence_number: output.length + 1,
      response,
    },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/**
 * Validates the output of the fixed control call and records it encrypted before
 * its names can make a direct client tool eligible for APPA authorization.
 */
export async function recordNativeCodexDiscovery(params: {
  session: AppaProxyHookSession;
  request: CodexWireObject;
}): Promise<CodexToolReference[] | null> {
  const scope = params.session.getNativeWireScope();
  const declared = declaredStandardNativeRegistry(params.request);
  if (declared) return declared;

  const bootstrap = await findBootstrapAlias({
    scope,
    request: params.request,
  });
  if (!bootstrap) return null;

  const toolNames = parseDiscoveryOutput({
    request: params.request,
    callId: bootstrap.wireId,
  });
  const discovered = toolNames.filter(
    (name) => name in NATIVE_TOOL_DESCRIPTIONS,
  );
  // A branded control proves the exact configured Archestra gateway namespace.
  // Once that namespace is present, its unbranded siblings are still genuine
  // gateway tools (for example, a dedicated fixture profile's write tool), not
  // arbitrary MCP names supplied by a client-local registry.
  const gatewayNamespaces = new Set(
    toolNames.flatMap((name) => {
      const marker = name.indexOf("__archestra__");
      return name.startsWith("mcp__") && marker >= 5
        ? [name.slice(0, marker)]
        : [];
    }),
  );
  const gatewayTools = toolNames.flatMap((name): CodexToolReference[] => {
    const namespace = [...gatewayNamespaces].find((candidate) =>
      name.startsWith(`${candidate}__`),
    );
    if (!namespace) return [];
    const toolName = name.slice(namespace.length + 2);
    return toolName ? [{ namespace, name: toolName, kind: "function" }] : [];
  });
  if (discovered.length === 0 && gatewayTools.length === 0) {
    throw new Error("Codex registry has no supported direct tools");
  }
  await AppaProxyWireModel.recordLocalObservation({
    ...scope,
    idempotencyKey: `codex-native-discovery:${scope.turnId}:${bootstrap.wireId}`,
    tools: Object.fromEntries(
      toolNames.map((name) => [
        name,
        { description: NATIVE_TOOL_DESCRIPTIONS[name] },
      ]),
    ),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  return [
    ...discovered.map(
      (name): CodexToolReference => ({
        namespace: "functions",
        name,
        // `apply_patch` stays custom on the client wire. The model sees its
        // non-strict {input:string} function projection only.
        kind: name === "apply_patch" ? "custom" : "function",
      }),
    ),
    ...gatewayTools,
  ];
}

export function toNativeCodexToolNames(
  registry: readonly CodexToolReference[],
): string[] {
  return registry.map((tool) => `${tool.namespace}.${tool.name}`);
}

export function nativeCodexPolicyToolName(name: string): string {
  return name in NATIVE_TOOL_DESCRIPTIONS ? `functions.${name}` : name;
}

/**
 * Resolves a native MCP namespace to the owning principal of an actually
 * registered gateway profile. This supplies the only safe fallback when the
 * LLM request used a provider credential that identifies no platform user.
 */
export async function resolveNativeCodexGatewayPrincipals(params: {
  organizationId: string;
  registry: readonly CodexToolReference[];
}): Promise<
  ReadonlyMap<string, { principalUserId: string; gatewayProfileId: string }>
> {
  const requestedNamespaces = new Set(
    params.registry.flatMap((tool) =>
      typeof tool.namespace === "string" &&
      /^mcp__[A-Za-z0-9_-]+$/.test(tool.namespace)
        ? [tool.namespace]
        : [],
    ),
  );
  if (requestedNamespaces.size === 0) return new Map();
  const profiles = await AgentModel.findGatewayProfilesByOrganizationId(
    params.organizationId,
  );
  const candidates = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    const namespace = `mcp__${toMcpClientServerName(profile.name)}`;
    if (!requestedNamespaces.has(namespace) || !profile.authorId) continue;
    candidates.set(namespace, [...(candidates.get(namespace) ?? []), profile]);
  }
  return new Map(
    [...candidates].map(([namespace, matches]) => {
      if (matches.length !== 1) {
        throw new Error("Native MCP gateway namespace is ambiguous");
      }
      const [match] = matches;
      if (!match?.authorId) {
        throw new Error("Native MCP gateway profile has no owning principal");
      }
      return [
        namespace,
        {
          principalUserId: match.authorId,
          gatewayProfileId: match.id,
        },
      ] as const;
    }),
  );
}

function registryFromClaimedToolSearchOutputs(
  outputs: readonly CodexWireObject[],
): CodexToolReference[] {
  const registry = new Map<string, CodexToolReference>();
  for (const output of outputs) {
    // Codex's client-side search receipt is a namespace wrapper, not a flat
    // list of wire names: `{ tools: [{ name: "mcp__<server>", tools: [...] }] }`.
    // These values are read only after AppaProxyWireModel has decrypted a
    // claimed receipt; raw client declarations never reach this decoder.
    for (const namespace of asObjects(output.tools)) {
      if (
        typeof namespace.name !== "string" ||
        !/^mcp__[A-Za-z0-9_-]+$/.test(namespace.name)
      ) {
        continue;
      }
      for (const tool of asObjects(namespace.tools)) {
        if (
          tool.type !== "function" ||
          typeof tool.name !== "string" ||
          !archestraMcpBranding.isToolName(tool.name)
        ) {
          continue;
        }
        // Preserve the declaration's actual branded name. The authenticated
        // gateway registry remains responsible for authorizing its target.
        registry.set(`${namespace.name}__${tool.name}`, {
          namespace: namespace.name,
          name: tool.name,
          kind: "function",
        });
      }
    }
  }
  return [...registry.values()];
}

/** Reloads the durable sealed search receipts after their client aliases were consumed. */
export async function loadIssuedCodexToolSearchRegistry(params: {
  session: AppaProxyHookSession;
}): Promise<CodexToolReference[]> {
  return registryFromClaimedToolSearchOutputs(
    await AppaProxyWireModel.listClaimedCodexToolSearchOutputs(
      params.session.getNativeWireScope(),
    ),
  );
}

/**
 * Converts only the already-issued search registry into the declared-target
 * identities used by the outbound APPA call gate.
 */
export function issuedCodexToolSearchMcpTargets(
  registry: readonly CodexToolReference[],
): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const tool of registry) {
    if (!tool.namespace?.startsWith("mcp__") || tool.name.length === 0) {
      continue;
    }
    const server = tool.namespace.slice("mcp__".length);
    if (server.length === 0) continue;
    const target = `mcp/${server}/${tool.name}`;
    // Standard Responses emits a flat `__` tool name, while Code Mode retains
    // the namespace separator in the adapter's accumulated call name.
    targets.set(`${tool.namespace}__${tool.name}`, target);
    targets.set(`${tool.namespace}.${tool.name}`, target);
  }
  return targets;
}

/** Stable comparison form shared by native call issuance and gateway execution. */
export function canonicalNativeMcpArguments(
  value: Record<string, unknown>,
): string {
  return canonicalJson(value);
}

/**
 * Bootstrap and durable gateway control traffic are not provider history and
 * cannot grant model tool access.
 */
export async function projectNativeCodexModelRequest(params: {
  session: AppaProxyHookSession;
  request: CodexWireObject;
  registry: readonly CodexToolReference[];
  principalUserId?: string;
}): Promise<CodexWireObject> {
  const scope = params.session.getNativeWireScope();
  const bootstrapIds = new Set<string>();
  for (const alias of await AppaProxyWireModel.listIssuedAliases(scope)) {
    const metadata = isObject(alias.metadata) ? alias.metadata : {};
    if (
      metadata.purpose !== "codex_native_registry_bootstrap" ||
      metadata.program !== APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM
    )
      continue;
    const saved = await AppaProxyWireModel.findOwned({
      ...scope,
      frameId: alias.frameId,
    });
    if (saved?.frame.protocol === "codex-native-bootstrap/v1")
      bootstrapIds.add(alias.wireId);
  }
  const controlIds = await findCompletedNativeControlIds({
    scope,
    request: params.request,
  });
  const normalized = normalizeCodexRequestToNativeTools({
    body: params.request,
  });
  const request = normalized.body;
  request.input = asObjects(request.input).filter((item) => {
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    return !(
      callId &&
      (item.type === "custom_tool_call" ||
        item.type === "custom_tool_call_output") &&
      bootstrapIds.has(callId)
    );
  });
  request.input = stripNativeCodexControlHistory({
    request,
    controlCallIds: controlIds,
  }).input;
  // Stock Codex declares direct local tools as top-level Responses functions.
  // Its client rejects the legacy Code Mode custom bootstrap, so preserve that
  // declaration dialect rather than synthesizing a `functions` namespace.
  if (nativeCodexDialect(params.request) === "standard-responses") {
    const tools = asObjects(request.tools);
    for (const tool of params.registry) {
      if (!tool.namespace?.startsWith("mcp__")) continue;
      const name = `${tool.namespace}__${tool.name}`;
      if (tools.some((candidate) => candidate.name === name)) continue;
      tools.push({
        type: "function",
        name,
        description: `Registered gateway tool ${tool.name}.`,
        parameters: { type: "object", additionalProperties: true },
        strict: false,
      });
    }
    request.tools = tools;
    return await restoreIssuedNativeToolHistory({
      scope,
      request,
      principalUserId: params.principalUserId,
    });
  }
  const tools = asObjects(request.tools);
  const originalExec = asObjects(params.request.input)
    .filter((item) => item.type === "additional_tools")
    .flatMap((item) => asObjects(item.tools))
    .flatMap((tool) =>
      tool.type === "namespace" ? asObjects(tool.tools) : [tool],
    )
    .find((tool) => tool.type === "custom" && tool.name === "exec");
  let functions = tools.find(
    (tool) => tool.type === "namespace" && tool.name === "functions",
  );
  if (!functions) {
    functions = { type: "namespace", name: "functions", tools: [] };
    tools.push(functions);
  }
  const members = asObjects(functions.tools).filter(
    (tool) => tool.name !== "exec" && tool.name !== "wait",
  );
  for (const tool of params.registry) {
    if (
      tool.namespace !== "functions" ||
      members.some((member) => member.name === tool.name)
    )
      continue;
    const parameters = NATIVE_PARAMETERS[tool.name];
    if (!parameters) continue;
    members.push({
      type: "function",
      name: tool.name,
      description: NATIVE_TOOL_DESCRIPTIONS[tool.name],
      parameters,
      strict: false,
    });
  }
  functions.tools = members;
  if (typeof originalExec?.description === "string") {
    functions.description =
      "Use the advertised direct function tools, not exec programs. Original tool API documentation follows:\n" +
      originalExec.description;
  }
  for (const tool of params.registry) {
    if (!tool.namespace?.startsWith("mcp__")) continue;
    let group = tools.find(
      (item) => item.type === "namespace" && item.name === tool.namespace,
    );
    if (!group) {
      group = { type: "namespace", name: tool.namespace, tools: [] };
      tools.push(group);
    }
    const groupTools = asObjects(group.tools);
    if (!groupTools.some((item) => item.name === tool.name)) {
      groupTools.push({
        type: "function",
        name: tool.name,
        description: `Registered gateway tool ${tool.name}.`,
        parameters: { type: "object", additionalProperties: true },
        strict: false,
      });
    }
    group.tools = groupTools;
  }
  request.tools = tools
    .filter((tool) => tool.type === "function" || tool.type === "namespace")
    .map((tool) =>
      tool.type === "namespace"
        ? {
            ...tool,
            tools: asObjects(tool.tools).filter(
              (member) => member.type === "function",
            ),
          }
        : tool,
    );
  return await restoreIssuedNativeToolHistory({
    scope,
    request,
    principalUserId: params.principalUserId,
  });
}

/** Removes only server-owned synthetic control call/output history. */
export function stripNativeCodexControlHistory<T>(params: {
  request: T;
  controlCallIds: ReadonlySet<string>;
}): T {
  if (!isObject(params.request) || !Array.isArray(params.request.input)) {
    return params.request;
  }
  return {
    ...params.request,
    input: params.request.input.filter(
      (item) =>
        !isObject(item) ||
        !isNativeToolTraffic(item) ||
        typeof item.call_id !== "string" ||
        !params.controlCallIds.has(item.call_id),
    ),
  } as T;
}

/** Native custom calls retain their client wire representation through projection. */
export function normalizeNativeCodexInput(request: unknown): unknown {
  return request;
}

export async function prepareNativeCodexCallAliases(params: {
  session: AppaProxyHookSession;
  request: unknown;
  response: unknown;
  calls: Array<{ id: string; name: string; arguments: string }>;
  /**
   * Credential-proven identity for gateway calls. Their thread binding comes
   * from the durable session, never from client attribution fields.
   */
  principalUserId?: string;
  /** Server-resolved owners of registered gateway namespaces in this request. */
  gatewayPrincipals?: ReadonlyMap<
    string,
    { principalUserId: string; gatewayProfileId: string }
  >;
}) {
  // Native replay currently has one authoritative call/result slot per issued
  // frame. Do not partially bind a concurrent batch: a later result could be
  // replayed against the wrong unfinished sibling.
  if (params.calls.length > 1) {
    throw new Error("Concurrent native tool-call batches are unsupported");
  }
  const scope = params.session.getNativeWireScope();
  const originalItems = isObject(params.response)
    ? asObjects(params.response.output).filter(isNativeToolCall)
    : [];
  const toolSearchCalls = isObject(params.response)
    ? asObjects(params.response.output).filter(isCodexToolSearchCall)
    : [];
  if (originalItems.length !== params.calls.length)
    throw new Error("Native response call positions are inconsistent");
  const providedIds = params.calls
    .map((call) => call.id)
    .filter((id) => typeof id === "string" && id.length > 0);
  if (new Set(providedIds).size !== providedIds.length)
    throw new Error("Native provider reused a call identifier");
  const allocatedCalls = params.calls.map((call) => ({
    ...call,
    id: `call_appa_${randomUUID().replaceAll("-", "")}`,
  }));
  const activeThreadId = await AppaProxyWireModel.getActiveNativeThreadId({
    ...scope,
    turnId: scope.turnId,
  });
  const nativeMcpBindings = allocatedCalls.map((call, position) => {
    if (!isNativeMcpGatewayCall(originalItems[position], call))
      return undefined;
    const registered = params.gatewayPrincipals?.get(
      nativeMcpNamespace(originalItems[position], call),
    );
    const principalUserId =
      params.principalUserId ?? registered?.principalUserId;
    if (!principalUserId || !registered?.gatewayProfileId || !activeThreadId) {
      throw new Error("Native MCP call has no registered gateway principal");
    }
    return {
      principalUserId,
      gatewayProfileId: registered?.gatewayProfileId,
      threadId: activeThreadId,
    };
  });
  const calls = allocatedCalls.map((call, position) => {
    const binding = nativeMcpBindings[position];
    return binding
      ? wrapNativeMcpCall({
          call,
          originalItem: originalItems[position],
          binding,
        })
      : call;
  });
  const nativeMcpTargets = allocatedCalls.map((call, position) =>
    nativeMcpExecutionTarget({
      call,
      originalItem: originalItems[position],
    }),
  );
  const frame = await AppaProxyWireModel.createFrame({
    ...scope,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: hash(params.request),
    idempotencyKey: `native-response:${scope.turnId}`,
    sourceResponseId:
      isObject(params.response) && typeof params.response.id === "string"
        ? params.response.id
        : undefined,
    payload: { request: params.request, response: params.response, calls },
    expiresAt: new Date(Date.now() + 300_000),
  });
  await AppaProxyWireModel.addAliases({
    ...scope,
    frameId: frame.id,
    aliases: [
      ...calls.map((call, position) => ({
        kind: "call" as const,
        position,
        wireId: call.id,
        logicalId: params.calls[position].id || undefined,
        metadata: {
          purpose: "native_call",
          providerCallId: params.calls[position].id || null,
          providerItemId:
            typeof originalItems[position]?.id === "string"
              ? originalItems[position].id
              : null,
          ...(nativeMcpBindings[position] && {
            principalUserId: nativeMcpBindings[position].principalUserId,
            gatewayProfileId: nativeMcpBindings[position].gatewayProfileId,
            threadId: nativeMcpBindings[position].threadId,
            itemId: `fc_${call.id}`,
            // The model sees a client-side namespace decoration, while the MCP
            // gateway receives the provider item's canonical tool name.
            toolName: nativeMcpTargets[position].toolName,
            argumentsCanonical: canonicalNativeMcpArguments(
              nativeMcpTargets[position].toolArgs,
            ),
            executionArgumentsCanonical: canonicalNativeMcpArguments(
              parseNativeMcpArguments(call.arguments),
            ),
          }),
        },
      })),
      ...toolSearchCalls.map((call, index) => ({
        kind: "call" as const,
        position: calls.length + index,
        wireId: call.call_id,
        logicalId: call.id,
        metadata: {
          purpose: "codex_tool_search",
          providerCallId: call.call_id,
          providerItemId: call.id,
          itemId: call.id,
          argumentsCanonical: canonicalToolSearchArguments(call.arguments),
          executionProfile: "client",
          // Search has no executable capability. Its issuer is still bound to
          // this credential-derived APPA scope; a user identity, when the
          // proxy has one, adds an additional recipient constraint.
          ...(params.principalUserId
            ? { principalUserId: params.principalUserId }
            : {}),
        },
      })),
    ],
  });
  return { calls, frameId: frame.id };
}

export async function issueNativeCodexFrame(params: {
  session: AppaProxyHookSession;
  frameId: string;
}) {
  const scope = params.session.getNativeWireScope();
  await AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
    ...scope,
    frameId: params.frameId,
  });
  await AppaProxyWireModel.markIssued({ ...scope, frameId: params.frameId });
}

/**
 * Freezes the exact APPA-authorized native wrapper before it is published. The
 * finalizer reads this committed copy, so response formatting cannot add or
 * remove the opaque locator after authorization.
 */
export async function commitNativeCodexCalls(params: {
  session: AppaProxyHookSession;
  frameId: string;
  calls: Array<{ id: string; name: string; arguments: string }>;
}): Promise<void> {
  const scope = params.session.getNativeWireScope();
  const held = await AppaProxyWireModel.findOwned({
    ...scope,
    frameId: params.frameId,
  });
  if (!held || held.frame.state !== "held" || !isObject(held.payload)) {
    throw new Error("Native response cannot commit an unpublished call");
  }
  const originalCalls = asObjects(held.payload.calls);
  if (
    originalCalls.length !== params.calls.length ||
    originalCalls.some(
      (call, index) =>
        call.id !== params.calls[index]?.id ||
        call.name !== params.calls[index]?.name,
    )
  ) {
    throw new Error("Native response call identity changed before publication");
  }
  await AppaProxyWireModel.replaceHeldPayload({
    ...scope,
    frameId: params.frameId,
    payload: { ...held.payload, committedCalls: params.calls },
  });
}

export function replaceNativeCodexCallItems<T>(
  response: T,
  calls: Array<{ id: string; name: string; arguments: string }>,
): T {
  if (!isObject(response) || !Array.isArray(response.output))
    throw new Error("Native response output is unavailable");
  let position = 0;
  const output = response.output.map((item) => {
    if (!isNativeToolCall(item)) return item;
    const call = calls[position++];
    if (!call) throw new Error("Native response call positions changed");
    const namespace =
      typeof item.namespace === "string" ? item.namespace : undefined;
    const prefix = namespace
      ? namespace + (namespace.startsWith("mcp__") ? "__" : ".")
      : "";
    const { namespace: _namespace, ...original } = item;
    if (item.type === "custom_tool_call") {
      const input = customToolInput(call.arguments);
      const { arguments: _arguments, input: _input, ...custom } = original;
      return {
        ...custom,
        id: `fc_${call.id}`,
        call_id: call.id,
        type: "custom_tool_call",
        name:
          prefix && call.name.startsWith(prefix)
            ? call.name.slice(prefix.length)
            : call.name,
        ...(prefix && call.name.startsWith(prefix) ? { namespace } : {}),
        input,
      };
    }
    return {
      ...original,
      id: `fc_${call.id}`,
      call_id: call.id,
      arguments: call.arguments,
      name:
        prefix && call.name.startsWith(prefix)
          ? call.name.slice(prefix.length)
          : call.name,
      ...(prefix && call.name.startsWith(prefix) ? { namespace } : {}),
    };
  });
  if (position !== calls.length)
    throw new Error("Native response call positions changed");
  return { ...response, output } as T;
}

/** Policy and result correlation run on client IDs; only the provider-facing copy changes. */
export async function restoreNativeCodexProviderIds(params: {
  session: AppaProxyHookSession;
  request: unknown;
  principalUserId?: string;
}) {
  if (!isObject(params.request) || !Array.isArray(params.request.input))
    return params.request;
  return await restoreIssuedNativeToolHistory({
    scope: params.session.getNativeWireScope(),
    request: params.request,
    principalUserId: params.principalUserId,
  });
}

/** Converts the one client-custom local patch call back to Code Mode wire. */
export function rewriteNativeCodexResponseForClient<T>(response: T): T {
  if (!isObject(response) || !Array.isArray(response.output)) return response;
  return {
    ...response,
    output: response.output.map((rawItem) => {
      let item = rawItem;
      if (
        isObject(item) &&
        item.type === "function_call" &&
        typeof item.name === "string" &&
        !item.namespace
      ) {
        const match =
          /^(functions|collaboration|mcp__[A-Za-z0-9_-]+)\.(.+)$/.exec(
            item.name,
          );
        if (match) item = { ...item, namespace: match[1], name: match[2] };
      }
      if (
        !isObject(item) ||
        item.type !== "function_call" ||
        item.namespace !== "functions" ||
        item.name !== "apply_patch" ||
        typeof item.arguments !== "string"
      ) {
        return item;
      }
      let input: unknown;
      try {
        input = JSON.parse(item.arguments).input;
      } catch {
        return item;
      }
      if (typeof input !== "string") return item;
      const { arguments: _arguments, ...customCall } = item;
      return { ...customCall, type: "custom_tool_call", input };
    }),
  } as T;
}

// === Internal helpers ===

const NATIVE_PARAMETERS: Record<string, CodexWireObject> = {
  exec_command: {
    type: "object",
    properties: {
      cmd: { type: "string" },
      workdir: { type: "string" },
      shell: { type: "string" },
      login: { type: "boolean" },
      yield_time_ms: { type: "integer" },
      max_output_tokens: { type: "integer" },
      timeout_ms: { type: "integer" },
    },
    required: ["cmd"],
    additionalProperties: true,
  },
  write_stdin: {
    type: "object",
    properties: {
      session_id: { type: "integer" },
      chars: { type: "string" },
      yield_time_ms: { type: "integer" },
      max_output_tokens: { type: "integer" },
    },
    required: ["session_id"],
    additionalProperties: true,
  },
  view_image: {
    type: "object",
    properties: { path: { type: "string" }, detail: { type: "string" } },
    required: ["path"],
    additionalProperties: true,
  },
  apply_patch: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  },
};

function hasCodeModeExec(item: CodexWireObject): boolean {
  return (
    item.type === "additional_tools" &&
    asObjects(item.tools).some(
      (tool) =>
        (tool.type === "custom" && tool.name === "exec") ||
        (tool.type === "namespace" &&
          tool.name === "functions" &&
          asObjects(tool.tools).some(
            (member) => member.type === "custom" && member.name === "exec",
          )),
    )
  );
}

function nativeCodexDialect(
  request: CodexWireObject,
): NativeCodexDialect | undefined {
  if (asObjects(request.input).some(hasCodeModeExec)) return "code-mode";
  return hasStandardResponsesNativeManifest(asObjects(request.tools))
    ? "standard-responses"
    : undefined;
}

/**
 * The standard Responses manifest is the client's authenticated declaration of
 * its direct local-tool surface. Unlike Code Mode there is no supported custom
 * registry command, so derive the registry solely from those declarations.
 */
function declaredStandardNativeRegistry(
  request: CodexWireObject,
): CodexToolReference[] | null {
  if (nativeCodexDialect(request) !== "standard-responses") return null;

  const registry: CodexToolReference[] = [];
  for (const tool of asObjects(request.tools)) {
    if (
      typeof tool.name !== "string" ||
      !(tool.name in NATIVE_TOOL_DESCRIPTIONS)
    ) {
      continue;
    }
    const kind = tool.type === "function" ? "function" : "custom";
    // `apply_patch` is the sole client custom direct tool. All remaining
    // native tools are standard Responses functions with JSON parameters.
    if ((tool.name === "apply_patch") !== (kind === "custom")) continue;
    registry.push({ namespace: "functions", name: tool.name, kind });
  }
  if (new Set(registry.map((tool) => tool.name)).size !== registry.length) {
    throw new Error(
      "Codex standard manifest declares a native tool more than once",
    );
  }
  return registry;
}

/**
 * Current stock Codex uses a standard top-level Responses function manifest.
 * Require both direct-process tools and their required argument schemas so an
 * arbitrary custom or one-off provider tool cannot opt into native handling.
 */
function hasStandardResponsesNativeManifest(
  tools: readonly CodexWireObject[],
): boolean {
  return (
    hasStandardResponsesFunction({
      tools,
      name: "exec_command",
      requiredParameter: "cmd",
    }) &&
    hasStandardResponsesFunction({
      tools,
      name: "write_stdin",
      requiredParameter: "session_id",
    })
  );
}

function hasStandardResponsesFunction(params: {
  tools: readonly CodexWireObject[];
  name: string;
  requiredParameter: string;
}): boolean {
  return params.tools.some((tool) => {
    if (
      tool.type !== "function" ||
      tool.name !== params.name ||
      !isObject(tool.parameters)
    ) {
      return false;
    }
    const required = tool.parameters.required;
    return (
      Array.isArray(required) && required.includes(params.requiredParameter)
    );
  });
}

async function findCompletedNativeControlIds(params: {
  scope: { sessionId: string; ownerScopeHash: string };
  request: CodexWireObject;
}): Promise<Set<string>> {
  const traffic = asObjects(params.request.input).filter(isNativeToolTraffic);
  const controlCalls = traffic.filter(isGatewayControlCall);
  const candidateIds = new Set(
    traffic.flatMap((item) => {
      if (typeof item.call_id !== "string") return [];
      return isGatewayControlCall(item) ||
        item.call_id.startsWith("call_appa_control_")
        ? [item.call_id]
        : [];
    }),
  );
  const ids = new Set<string>();
  if (controlCalls.some((call) => typeof call.call_id !== "string")) {
    throw new Error("Native gateway control call has no durable identity");
  }
  for (const callId of candidateIds) {
    const control = await AppaProxyWireModel.findByControlCall({
      ...params.scope,
      controlCallId: callId,
    });
    const payload =
      control && AppaControlFramePayloadSchema.safeParse(control.payload);
    if (
      !control ||
      !payload?.success ||
      control.frame.kind !== "remedy_control" ||
      control.frame.controlCallId !== callId ||
      control.frame.state !== "completed" ||
      control.receipt === null
    ) {
      throw new Error("Native gateway control has no completed owned receipt");
    }
    ids.add(callId);
  }
  return ids;
}

function isGatewayControlCall(item: CodexWireObject): boolean {
  return (
    isNativeToolTraffic(item) &&
    typeof item.namespace === "string" &&
    /^mcp__[A-Za-z0-9_-]+$/.test(item.namespace) &&
    typeof item.name === "string" &&
    [
      "archestra__appa_inspect_plan",
      "archestra__appa_execute_remedy",
      "archestra__appa_status",
    ].includes(item.name)
  );
}

function isNativeToolTraffic(item: CodexWireObject): boolean {
  return (
    item.type === "function_call" ||
    item.type === "function_call_output" ||
    item.type === "custom_tool_call" ||
    item.type === "custom_tool_call_output"
  );
}

function isIssuedNativeMcpToolCall(
  item: CodexWireObject,
): item is CodexWireObject & {
  type: "mcp_tool_call";
  tool: "archestra__run_tool";
  arguments: Record<string, unknown>;
} {
  return (
    item.type === "mcp_tool_call" &&
    item.tool === "archestra__run_tool" &&
    isObject(item.arguments) &&
    isObject(item.arguments.wire_context)
  );
}

function nativeMcpCallId(item: { arguments: Record<string, unknown> }): string {
  const context = item.arguments.wire_context;
  if (!isObject(context) || typeof context.call_id !== "string") {
    throw new Error("Native MCP call has no sealed locator");
  }
  return context.call_id;
}

function isNativeToolCall(item: CodexWireObject): item is CodexWireObject & {
  type: "function_call" | "custom_tool_call";
  call_id: string;
  name: string;
} {
  return (
    (item.type === "function_call" || item.type === "custom_tool_call") &&
    typeof item.call_id === "string" &&
    typeof item.name === "string"
  );
}

function isNativeToolOutput(item: CodexWireObject): item is CodexWireObject & {
  type: "function_call_output" | "custom_tool_call_output";
  call_id: string;
} {
  return (
    (item.type === "function_call_output" ||
      item.type === "custom_tool_call_output") &&
    typeof item.call_id === "string"
  );
}

/**
 * The encrypted response frame is the source of truth for native tool-call
 * history. Client values may supply a result body, but they cannot change a
 * call's kind, provider fields, or identifiers.
 */
async function restoreIssuedNativeToolHistory(params: {
  scope: { sessionId: string; ownerScopeHash: string };
  request: CodexWireObject;
  principalUserId?: string;
}): Promise<CodexWireObject> {
  const bindings = await issuedNativeToolBindings(params.scope);
  return {
    ...params.request,
    input: Array.isArray(params.request.input)
      ? await Promise.all(
          params.request.input.map(async (rawItem) => {
            if (!isObject(rawItem)) return rawItem;
            const item = rawItem;
            if (isIssuedNativeMcpToolCall(item)) {
              const callId = nativeMcpCallId(item);
              const binding = bindingForCallId(bindings, callId);
              if (
                !binding ||
                binding.executionArgumentsCanonical === undefined ||
                canonicalNativeMcpArguments(item.arguments) !==
                  binding.executionArgumentsCanonical
              ) {
                throw new Error("Native MCP call has no issued wire binding");
              }
              return structuredClone(binding.item);
            }
            if (isNativeToolCall(item)) {
              const binding = bindingForCallId(bindings, item.call_id);
              if (!binding || binding.item.type !== item.type) {
                throw new Error("Native tool call has no issued wire binding");
              }
              return structuredClone(binding.item);
            }
            if (isNativeToolOutput(item)) {
              const binding = bindingForCallId(bindings, item.call_id);
              if (!binding || toolOutputType(binding.item.type) !== item.type) {
                throw new Error(
                  "Native tool output has no issued wire binding",
                );
              }
              return { ...item, call_id: binding.item.call_id };
            }
            if (isCodexToolSearchCall(item)) {
              const binding = bindingForToolSearchCall(bindings, item.call_id);
              if (
                !binding ||
                item.id !== binding.item.id ||
                item.execution !== "client" ||
                canonicalToolSearchArguments(item.arguments) !==
                  binding.argumentsCanonical
              ) {
                throw new Error(
                  "Codex tool search call has no issued wire binding",
                );
              }
              return structuredClone(binding.item);
            }
            if (isCodexToolSearchOutput(item)) {
              return resolveIssuedToolSearchOutput({
                scope: params.scope,
                item,
                principalUserId: params.principalUserId,
              });
            }
            if (isUnsupportedNativeToolItem(item)) {
              throw new Error(
                "Native history contains an unsupported tool item",
              );
            }
            return item;
          }),
        )
      : params.request.input,
  };
}

type IssuedNativeToolBindings = {
  calls: Array<{
    clientCallId: string;
    /** Exact issued client wrapper; absent only for pre-native-MCP aliases. */
    executionArgumentsCanonical?: string;
    item: CodexWireObject & {
      type: "function_call" | "custom_tool_call";
      call_id: string;
      name: string;
    };
  }>;
  toolSearch: Array<{
    callId: string;
    item: CodexWireObject & {
      id: string;
      call_id: string;
      type: "tool_search_call";
      execution: "client";
    };
    argumentsCanonical: string;
  }>;
};

async function issuedNativeToolBindings(scope: {
  sessionId: string;
  ownerScopeHash: string;
}): Promise<IssuedNativeToolBindings> {
  const bindings: IssuedNativeToolBindings = { calls: [], toolSearch: [] };
  for (const alias of await AppaProxyWireModel.listIssuedAliases(scope)) {
    if (
      alias.kind !== "call" ||
      !isObject(alias.metadata) ||
      (alias.metadata.purpose !== "native_call" &&
        alias.metadata.purpose !== "codex_native_registry_bootstrap" &&
        alias.metadata.purpose !== "codex_tool_search")
    ) {
      continue;
    }
    const metadata = alias.metadata;
    const frame = await AppaProxyWireModel.findOwned({
      ...scope,
      frameId: alias.frameId,
    });
    if (metadata.purpose === "codex_tool_search") {
      const response = isObject(frame?.payload)
        ? frame.payload.response
        : undefined;
      const item = asObjects(
        isObject(response) ? response.output : undefined,
      ).find(
        (candidate) =>
          isCodexToolSearchCall(candidate) &&
          candidate.call_id === alias.wireId &&
          candidate.id === metadata.itemId,
      );
      if (
        frame?.frame.protocol !== "codex-native-response/v1" ||
        !item ||
        typeof metadata.argumentsCanonical !== "string"
      ) {
        throw new Error("Codex tool search alias has no issued response frame");
      }
      bindings.toolSearch.push({
        callId: alias.wireId,
        item: item as IssuedNativeToolBindings["toolSearch"][number]["item"],
        argumentsCanonical: metadata.argumentsCanonical,
      });
      continue;
    }
    if (metadata.purpose === "codex_native_registry_bootstrap") {
      const item = asObjects(
        isObject(frame?.payload) ? frame.payload.output : undefined,
      ).find(
        (candidate) =>
          candidate.type === "custom_tool_call" &&
          candidate.call_id === alias.wireId &&
          candidate.namespace === "functions" &&
          candidate.name === "exec" &&
          candidate.input === APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM,
      );
      if (frame?.frame.protocol !== "codex-native-bootstrap/v1" || !item) {
        throw new Error("Native bootstrap alias has no issued response frame");
      }
      bindings.calls.push({
        clientCallId: alias.wireId,
        item: item as IssuedNativeToolBindings["calls"][number]["item"],
      });
      continue;
    }
    if (frame?.frame.protocol !== "codex-native-response/v1") {
      throw new Error("Native tool alias has no issued response frame");
    }
    const response = isObject(frame.payload)
      ? frame.payload.response
      : undefined;
    const item = asObjects(
      isObject(response) ? response.output : undefined,
    ).find(
      (candidate) =>
        (typeof metadata.providerCallId === "string" &&
          candidate.call_id === metadata.providerCallId) ||
        (typeof metadata.providerItemId === "string" &&
          candidate.id === metadata.providerItemId),
    );
    if (!item || !isNativeToolCall(item)) {
      throw new Error("Native tool alias does not match its issued response");
    }
    bindings.calls.push({
      clientCallId: alias.wireId,
      item,
      executionArgumentsCanonical:
        typeof metadata.executionArgumentsCanonical === "string"
          ? metadata.executionArgumentsCanonical
          : undefined,
    });
  }
  return bindings;
}

function bindingForToolSearchCall(
  bindings: IssuedNativeToolBindings,
  callId: string,
) {
  return bindings.toolSearch.find((binding) => binding.callId === callId);
}

async function resolveIssuedToolSearchOutput(params: {
  scope: { sessionId: string; ownerScopeHash: string };
  item: CodexWireObject & { call_id: string; type: "tool_search_output" };
  principalUserId?: string;
}): Promise<CodexWireObject> {
  const result = await AppaProxyWireModel.claimCodexToolSearchOutput({
    ...params.scope,
    callId: params.item.call_id,
    principalUserId: params.principalUserId,
    output: params.item,
  });
  return result.output;
}

function bindingForCallId(bindings: IssuedNativeToolBindings, callId: string) {
  return bindings.calls.find(
    (binding) =>
      binding.clientCallId === callId || binding.item.call_id === callId,
  );
}

function toolOutputType(
  callType: "function_call" | "custom_tool_call",
): "function_call_output" | "custom_tool_call_output" {
  return callType === "custom_tool_call"
    ? "custom_tool_call_output"
    : "function_call_output";
}

function isUnsupportedNativeToolItem(item: CodexWireObject): boolean {
  if (typeof item.type !== "string") return false;
  return (
    /(?:_tool)?_call(?:_output)?$/.test(item.type) && !isNativeToolTraffic(item)
  );
}

function customToolInput(argumentsText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    throw new Error("Native custom tool call arguments are invalid");
  }
  if (!isObject(parsed) || typeof parsed.input !== "string") {
    throw new Error("Native custom tool call has no string input");
  }
  return parsed.input;
}

async function findBootstrapAlias(params: {
  scope: { sessionId: string; ownerScopeHash: string };
  request: CodexWireObject;
}) {
  const outputCallIds = new Set(
    asObjects(params.request.input)
      .filter((item) => item.type === "custom_tool_call_output")
      .map((item) => item.call_id)
      .filter((callId): callId is string => typeof callId === "string"),
  );
  for (const alias of await AppaProxyWireModel.listIssuedAliases(
    params.scope,
  )) {
    if (alias.kind !== "call" || !outputCallIds.has(alias.wireId)) continue;
    const frame = await AppaProxyWireModel.findOwned({
      ...params.scope,
      frameId: alias.frameId,
    });
    const output = isObject(frame?.payload)
      ? asObjects(frame.payload.output)
      : [];
    const control = output[0];
    if (
      frame?.frame.protocol === "codex-native-bootstrap/v1" &&
      control?.type === "custom_tool_call" &&
      control.call_id === alias.wireId &&
      control.namespace === "functions" &&
      control.name === "exec" &&
      control.input === APPA_LOCAL_REGISTRY_DISCOVERY_PROGRAM
    ) {
      return alias;
    }
  }
  return undefined;
}

function parseDiscoveryOutput(params: {
  request: CodexWireObject;
  callId: string;
}): string[] {
  const output = asObjects(params.request.input).find(
    (item) =>
      item.type === "custom_tool_call_output" && item.call_id === params.callId,
  )?.output;
  const parts = asObjects(output);
  const text = parts
    .flatMap((part) =>
      part.type === "input_text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .findLast((value) => value.trim().startsWith("["));
  if (!text) throw new Error("Codex registry bootstrap output is missing");
  let names: unknown;
  try {
    names = JSON.parse(text);
  } catch {
    throw new Error("Codex registry bootstrap output is invalid");
  }
  if (
    !Array.isArray(names) ||
    names.length > 10_000 ||
    names.some(
      (name) =>
        typeof name !== "string" || name.length === 0 || name.length > 512,
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Codex registry bootstrap output is invalid");
  }
  return names as string[];
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });
  if (serialized === undefined)
    throw new Error("Native MCP arguments are not serializable");
  return serialized;
}

function canonicalToolSearchArguments(value: unknown): string {
  if (typeof value === "string") {
    try {
      return canonicalJson(JSON.parse(value));
    } catch {
      throw new Error("Codex tool search arguments are invalid");
    }
  }
  if (!isObject(value))
    throw new Error("Codex tool search arguments are invalid");
  return canonicalJson(value);
}

function parseNativeMcpArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Native MCP call arguments are invalid");
  }
  if (!isObject(parsed))
    throw new Error("Native MCP call arguments are invalid");
  return parsed;
}

function nativeMcpToolName(params: {
  call: { name: string };
  originalItem: CodexWireObject | undefined;
}): string {
  const namespace = params.originalItem?.namespace;
  const name = params.originalItem?.name;
  return typeof namespace === "string" &&
    namespace.startsWith("mcp__") &&
    typeof name === "string" &&
    name.length > 0
    ? name
    : params.call.name;
}

function isNativeMcpGatewayCall(
  originalItem: CodexWireObject | undefined,
  call: { name: string },
): boolean {
  return (
    call.name.startsWith("mcp__") ||
    (typeof originalItem?.namespace === "string" &&
      originalItem.namespace.startsWith("mcp__"))
  );
}

function nativeMcpNamespace(
  originalItem: CodexWireObject | undefined,
  call: { name: string },
): string {
  if (
    typeof originalItem?.namespace === "string" &&
    originalItem.namespace.startsWith("mcp__")
  ) {
    return originalItem.namespace;
  }
  return /^((?:mcp__[A-Za-z0-9_-]+))__(.+)$/.exec(call.name)?.[1] ?? "";
}

function wrapNativeMcpCall(params: {
  call: { id: string; name: string; arguments: string };
  originalItem: CodexWireObject | undefined;
  binding: { principalUserId: string; threadId: string };
}): { id: string; name: string; arguments: string } {
  const target = nativeMcpExecutionTarget(params);
  const namespace =
    typeof params.originalItem?.namespace === "string" &&
    params.originalItem.namespace.startsWith("mcp__")
      ? params.originalItem.namespace
      : /^((?:mcp__[A-Za-z0-9_-]+))__(.+)$/.exec(params.call.name)?.[1];
  if (!namespace) return params.call;
  return {
    ...params.call,
    name: `${namespace}__archestra__run_tool`,
    arguments: JSON.stringify({
      tool_name: target.toolName,
      tool_args: target.toolArgs,
      wire_context: {
        call_id: params.call.id,
        thread_id: params.binding.threadId,
        item_id: `fc_${params.call.id}`,
      },
    }),
  };
}

/**
 * Codex may already have selected the gateway's advertised run_tool. The
 * native capability owns that one outer envelope, so unwrap it exactly once
 * before sealing; the target's strict schema must never receive dispatcher
 * keys or a wire locator.
 */
function nativeMcpExecutionTarget(params: {
  call: { name: string; arguments: string };
  originalItem: CodexWireObject | undefined;
}): { toolName: string; toolArgs: Record<string, unknown> } {
  const args = parseNativeMcpArguments(params.call.arguments);
  const emittedName = nativeMcpToolName(params);
  if (!isRunToolName(emittedName)) {
    return { toolName: emittedName, toolArgs: args };
  }
  if (
    !hasExactKeys(args, ["tool_name", "tool_args"]) ||
    typeof args.tool_name !== "string" ||
    !isObject(args.tool_args) ||
    isRunToolName(args.tool_name)
  ) {
    throw new Error("Native MCP run_tool envelope is invalid");
  }
  return { toolName: args.tool_name, toolArgs: args.tool_args };
}

function isRunToolName(name: string): boolean {
  return (
    name === "archestra__run_tool" || name.endsWith("__archestra__run_tool")
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function asObjects(value: unknown): CodexWireObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function isObject(value: unknown): value is CodexWireObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
