import AppaNativeChildCorrelationModel from "@/models/appa-native-child-correlation";
import { AppaProxySessionProtocolError } from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type { CodexTaskAlias } from "@/routes/proxy/appa-codex-wire";

type NativeChildTaskMetadata = {
  purpose: "native_child_task";
  clientTaskPath: string;
  clientParentTaskPath: string;
};

type NativeChildScope = {
  sessionId: string;
  ownerScopeHash: string;
  profileId: string;
};

/**
 * Exact pending handler integration before `issueNativeCodexFrame`: rewrite
 * the released `spawn_agent` item's `task_name` to `wireTaskName`, then persist
 * `alias` through `AppaProxyWireModel.addAliases`. The alias is correlation
 * only; `spawnBinding` remains runtime execution authority.
 */
export function prepareNativeChildSpawnPublication(params: {
  taskAlias: CodexTaskAlias;
  position: number;
  clientParentTaskPath: string;
  logicalParentTaskPath: string;
  originalProviderTaskName: string;
  approvedCall: { callId: string; spawnBinding: string | null };
}) {
  const { taskAlias } = params;
  if (
    !taskAlias.wireTaskName ||
    !isTaskPath(params.clientParentTaskPath) ||
    !isTaskPath(params.logicalParentTaskPath) ||
    !isTaskPath(taskAlias.clientTaskPath) ||
    !isTaskPath(taskAlias.logicalTaskPath) ||
    !Number.isInteger(params.position) ||
    params.position < 0 ||
    !isIdentifier(params.originalProviderTaskName) ||
    !isIdentifier(params.approvedCall.callId) ||
    !isIdentifier(params.approvedCall.spawnBinding) ||
    taskAlias.clientTaskPath !==
      `${params.clientParentTaskPath}/${taskAlias.wireTaskName}` ||
    taskAlias.logicalTaskPath !==
      `${params.logicalParentTaskPath}/${params.originalProviderTaskName}`
  ) {
    throw new AppaProxySessionProtocolError(
      "native child task alias is invalid",
    );
  }
  return {
    rewrittenTaskName: taskAlias.wireTaskName,
    alias: {
      kind: "task" as const,
      position: params.position,
      wireId: taskAlias.wireTaskName,
      logicalId: taskAlias.logicalTaskPath,
      sourceCallId: params.approvedCall.callId,
      metadata: {
        purpose: "native_child_task" as const,
        clientTaskPath: taskAlias.clientTaskPath,
        clientParentTaskPath: params.clientParentTaskPath,
      } satisfies NativeChildTaskMetadata,
    },
  };
}

/**
 * Exact pending handler integration before `AppaProxyHookSession.acquire`:
 * pass the returned `spawnBinding` with the extracted stock request metadata.
 * This lookup does not consume or attach; `acquire` atomically consumes it.
 */
export async function resolveNativeChildSpawnBinding(params: {
  ownerScopeHash: string;
  profileId: string;
  parentClientSessionId: string;
  childTaskPath: string;
}): Promise<{ spawnBinding: string; logicalTaskPath: string }> {
  const parent =
    await AppaNativeChildCorrelationModel.findOwnedParentByClient(params);
  const alias = await findIssuedNativeChildAlias({
    scope: { sessionId: parent.id, ownerScopeHash: params.ownerScopeHash },
    clientTaskPath: params.childTaskPath,
  });
  const binding = await AppaNativeChildCorrelationModel.resolvePendingSpawn({
    parentSessionId: parent.id,
    ownerScopeHash: params.ownerScopeHash,
    profileId: params.profileId,
    taskAliasId: alias.id,
    sourceCallId: alias.sourceCallId,
  });
  if (!alias.logicalId || !isTaskPath(alias.logicalId)) {
    throw new AppaProxySessionProtocolError(
      "native child task alias has no logical task path",
    );
  }
  return { ...binding, logicalTaskPath: alias.logicalId };
}

/**
 * Exact pending handler integration immediately after successful `acquire` and
 * before `sendPrompt`. A parent thread ID by itself is deliberately insufficient.
 */
export async function attachNativeChild(params: {
  ownerScopeHash: string;
  profileId: string;
  parentClientSessionId: string;
  childClientSessionId: string;
  childTaskPath: string;
  spawnBinding: string;
}): Promise<void> {
  const parent = await AppaNativeChildCorrelationModel.findOwnedParentByClient({
    ownerScopeHash: params.ownerScopeHash,
    profileId: params.profileId,
    parentClientSessionId: params.parentClientSessionId,
  });
  const alias = await findIssuedNativeChildAlias({
    scope: { sessionId: parent.id, ownerScopeHash: params.ownerScopeHash },
    clientTaskPath: params.childTaskPath,
  });
  await AppaNativeChildCorrelationModel.attach({
    parentSessionId: parent.id,
    ownerScopeHash: params.ownerScopeHash,
    profileId: params.profileId,
    childClientSessionId: params.childClientSessionId,
    taskAliasId: alias.id,
    sourceCallId: alias.sourceCallId,
    spawnBinding: params.spawnBinding,
  });
}

/**
 * Extracts the child identity and task path from stock Codex headers/body
 * metadata. Handler integration should call this on the original request; a
 * mismatch or omission is not a child request and must not use alias lookup.
 */
export function extractNativeChildRequest(params: {
  headers: Record<string, unknown>;
  request: unknown;
}): {
  parentClientSessionId: string;
  childClientSessionId: string;
  childTaskPath: string;
} | null {
  const metadata = parseTurnMetadata({
    headers: params.headers,
    request: params.request,
  });
  if (!metadata) return null;
  const clientMetadata = object(object(params.request).client_metadata);
  const parentClientSessionId = singleMatchingIdentifier([
    header(params.headers, "x-codex-parent-thread-id"),
    string(clientMetadata.parent_thread_id),
    string(metadata.parent_thread_id),
  ]);
  const childClientSessionId = singleMatchingIdentifier([
    header(params.headers, "thread-id"),
    string(clientMetadata.thread_id),
    string(metadata.thread_id),
  ]);
  if (
    !isIdentifier(parentClientSessionId) ||
    !isIdentifier(childClientSessionId) ||
    !isTaskPath(metadata.agent_name)
  ) {
    return null;
  }
  return {
    parentClientSessionId,
    childClientSessionId,
    childTaskPath: metadata.agent_name,
  };
}

/**
 * Exact pending handler integration for native outbound spawn publication: use
 * the current stock agent name as the client parent task path. It is a locator
 * only, never a capability or authorization decision.
 */
export function extractNativeTaskPath(params: {
  headers: Record<string, unknown>;
  request: unknown;
}): string | null {
  const metadata = parseTurnMetadata(params);
  return metadata && isTaskPath(metadata.agent_name)
    ? metadata.agent_name
    : null;
}

/**
 * Extracts only the fixed, stock-Codex completion envelope headers. Payload
 * text remains opaque and is neither returned, transformed, nor persisted.
 *
 * @public Native bridge admission must invoke this before projecting an exact
 * verified `agent_message`; the bridge currently rejects that type instead.
 */
export function parseNativeChildCompletionEnvelope(value: unknown): {
  clientParentTaskPath: string;
  clientTaskPath: string;
} | null {
  if (typeof value !== "string") return null;
  const match =
    /^Message Type: FINAL_ANSWER\nTask name: ([^\n]+)\nSender: ([^\n]+)\nPayload:\n/s.exec(
      value,
    );
  if (!match || !isTaskPath(match[1]) || !isTaskPath(match[2])) return null;
  return {
    clientParentTaskPath: match[1],
    clientTaskPath: match[2],
  };
}

/**
 * Exact pending handler integration after parent `acquire` and before history
 * or prompt admission: pass each raw stock `agent_message` completion content.
 * It admits one completion for the child task alias already attached.
 *
 * @public Native bridge must first add an exact verified-item projection hook
 * so this one-use admission cannot consume a completion that projection drops.
 */
export async function admitNativeChildCompletion(
  params: NativeChildScope & {
    content: unknown;
  },
): Promise<void> {
  const envelope = parseNativeChildCompletionEnvelope(params.content);
  if (!envelope) {
    throw new AppaProxySessionProtocolError(
      "native child completion envelope is invalid",
    );
  }
  const alias = await findIssuedNativeChildAlias({
    scope: params,
    clientTaskPath: envelope.clientTaskPath,
    clientParentTaskPath: envelope.clientParentTaskPath,
  });
  if (!alias.childThreadId) {
    throw new AppaProxySessionProtocolError(
      "native child completion has no attached task alias",
    );
  }
  await AppaNativeChildCorrelationModel.admitCompletion({
    parentSessionId: params.sessionId,
    ownerScopeHash: params.ownerScopeHash,
    profileId: params.profileId,
    childClientSessionId: alias.childThreadId,
    taskAliasId: alias.id,
    sourceCallId: alias.sourceCallId,
  });
}

async function findIssuedNativeChildAlias(params: {
  scope: Pick<NativeChildScope, "sessionId" | "ownerScopeHash">;
  clientTaskPath: string;
  clientParentTaskPath?: string;
}) {
  if (
    !isTaskPath(params.clientTaskPath) ||
    (params.clientParentTaskPath !== undefined &&
      !isTaskPath(params.clientParentTaskPath))
  ) {
    throw new AppaProxySessionProtocolError(
      "native child task path is invalid",
    );
  }
  const matches = (
    await AppaProxyWireModel.listIssuedAliases(params.scope)
  ).filter((alias) => {
    if (alias.kind !== "task" || !isNativeChildMetadata(alias.metadata)) {
      return false;
    }
    return (
      alias.metadata.clientTaskPath === params.clientTaskPath &&
      (params.clientParentTaskPath === undefined ||
        alias.metadata.clientParentTaskPath === params.clientParentTaskPath)
    );
  });
  const [match] = matches;
  if (!match?.sourceCallId) {
    throw new AppaProxySessionProtocolError(
      "native child task has no unique issued spawn alias",
    );
  }
  return {
    id: match.id,
    sourceCallId: match.sourceCallId,
    childThreadId: match.childThreadId,
    logicalId: match.logicalId,
  };
}

function isNativeChildMetadata(
  value: unknown,
): value is NativeChildTaskMetadata {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).purpose === "native_child_task" &&
    isTaskPath((value as Record<string, unknown>).clientTaskPath) &&
    isTaskPath((value as Record<string, unknown>).clientParentTaskPath)
  );
}

function isTaskPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 512 &&
    value.startsWith("/") &&
    !value.includes("\n")
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function parseTurnMetadata(params: {
  headers: Record<string, unknown>;
  request: unknown;
}): Record<string, unknown> | null {
  const clientMetadata = object(object(params.request).client_metadata);
  const raw =
    header(params.headers, "x-codex-turn-metadata") ??
    clientMetadata["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try {
      return object(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? object(raw) : null;
}

function header(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  return string(
    Object.entries(headers).find(
      ([candidate]) => candidate.toLowerCase() === name,
    )?.[1],
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function singleMatchingIdentifier(
  values: Array<string | undefined>,
): string | undefined {
  const present = values.filter(
    (value): value is string => value !== undefined,
  );
  if (
    present.length === 0 ||
    present.some((value) => !isIdentifier(value)) ||
    new Set(present).size !== 1
  ) {
    return undefined;
  }
  return present[0];
}
