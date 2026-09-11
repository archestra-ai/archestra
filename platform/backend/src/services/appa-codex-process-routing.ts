import { createHash, randomInt } from "node:crypto";
import AppaProxySessionModel, {
  AppaProxySessionProtocolError,
} from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import {
  inspectCodexShellOutput,
  rewriteCodexShellHandle,
} from "@/routes/proxy/appa-codex-shell";

type NativeWireScope = {
  sessionId: string;
  ownerScopeHash: string;
  turnId: string;
};

/**
 * @public - native Codex proxy handling calls this before releasing an inbound result.
 *
 * Persists the association between a local Codex process handle and the proxy
 * handle exposed to the model. A handle proves only this correlation; it never
 * proves that a process executed or remains live.
 */
export async function persistNativeCodexProcessRoute(params: {
  scope: NativeWireScope;
  sourceCallId: string;
  output: unknown;
}): Promise<{ output: string; proxySessionId: number }> {
  const observation = inspectCodexShellOutput(params.output);
  if (
    typeof params.output !== "string" ||
    observation.processState !== "running" ||
    observation.localSessionId === undefined ||
    observation.localSessionId < 0
  ) {
    throw new AppaProxySessionProtocolError(
      "native process result has no verified live local handle",
    );
  }

  const existing = (
    await AppaProxyWireModel.listIssuedAliases(params.scope)
  ).find(
    (alias) =>
      alias.kind === "process" && alias.logicalId === params.sourceCallId,
  );
  if (existing) {
    if (!isProcessRouteMetadata(existing.metadata)) {
      throw new AppaProxySessionProtocolError(
        "stored native process route is invalid",
      );
    }
    if (existing.metadata.localSessionId !== observation.localSessionId) {
      throw new AppaProxySessionProtocolError(
        "native process handle changed for its original call",
      );
    }
    const proxySessionId = parseProxySessionId(existing.wireId);
    return {
      output: rewriteCodexShellHandle({
        output: params.output,
        expectedLocalId: observation.localSessionId,
        proxyId: proxySessionId,
      }),
      proxySessionId,
    };
  }

  const proxySessionId = await allocateProxySessionId(params.scope);
  const payload = {
    version: 1,
    purpose: "native_process_handle_correlation",
    sourceCallId: params.sourceCallId,
    localSessionId: observation.localSessionId,
    proxySessionId,
  };
  const frame = await AppaProxyWireModel.createFrame({
    ...params.scope,
    kind: "inbound_hold",
    protocol: "codex-native-process-route/v1",
    requestHash: JSON.stringify(payload),
    idempotencyKey: `codex-native-process-route:${params.scope.turnId}:${identifierHash(params.sourceCallId)}`,
    payload,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  await AppaProxyWireModel.addAliases({
    ...params.scope,
    frameId: frame.id,
    aliases: [
      {
        kind: "process",
        position: 0,
        wireId: String(proxySessionId),
        logicalId: params.sourceCallId,
        sourceCallId: params.sourceCallId,
        metadata: {
          purpose: "native_process_handle_correlation",
          localSessionId: observation.localSessionId,
        },
      },
    ],
  });
  await AppaProxyWireModel.markReady({ ...params.scope, frameId: frame.id });
  await AppaProxyWireModel.markIssued({ ...params.scope, frameId: frame.id });
  return {
    output: rewriteCodexShellHandle({
      output: params.output,
      expectedLocalId: observation.localSessionId,
      proxyId: proxySessionId,
    }),
    proxySessionId,
  };
}

/**
 * @public - native Codex proxy handling calls this after authorization and before client execution.
 *
 * Converts a model-visible proxy handle to the matching local Codex handle.
 * Unknown handles intentionally do not fall back to raw client execution.
 */
export async function restoreNativeCodexProcessRoute(params: {
  scope: NativeWireScope;
  arguments: string;
}): Promise<string> {
  const argumentsObject = parseProxyWriteStdinArguments(params.arguments);
  const proxySessionId = argumentsObject.session_id;
  const route = await findActiveRoute({
    scope: params.scope,
    proxySessionId,
  });
  return JSON.stringify({
    ...argumentsObject,
    session_id: route.localSessionId,
  });
}

/**
 * Normalizes client-local write_stdin history in place before native opaque
 * history is validated or sent to the provider. The durable proxy arguments
 * remain the canonical server and provider representation.
 */
export async function normalizeNativeCodexProcessHistory(params: {
  scope: NativeWireScope;
  request: unknown;
}): Promise<void> {
  if (!isObject(params.request) || !Array.isArray(params.request.input)) return;
  const callsById = new Map(
    (await AppaProxySessionModel.listCalls(params.scope.sessionId)).map(
      (call) => [call.callId, call],
    ),
  );
  const input = [];
  for (const item of params.request.input) {
    if (
      !isObject(item) ||
      item.type !== "function_call" ||
      typeof item.call_id !== "string" ||
      typeof item.arguments !== "string"
    ) {
      input.push(item);
      continue;
    }
    const call = callsById.get(item.call_id);
    if (call?.emittedName !== "functions.write_stdin") {
      input.push(item);
      continue;
    }
    input.push({
      ...item,
      arguments: await normalizeNativeCodexWriteStdinArguments({
        scope: params.scope,
        sourceCallId: item.call_id,
        proxyArguments: call.emittedArguments,
        clientArguments: item.arguments,
      }),
    });
  }
  params.request.input = input;
}

/** Returns a client-only copy with local handles restored after publication. */
export async function restoreNativeCodexClientProcessCalls<
  T extends { name: string; arguments: string },
>(params: { scope: NativeWireScope; calls: readonly T[] }): Promise<T[]> {
  return await Promise.all(
    params.calls.map(async (call) =>
      call.name === "functions.write_stdin"
        ? {
            ...call,
            arguments: await restoreNativeCodexProcessRoute({
              scope: params.scope,
              arguments: call.arguments,
            }),
          }
        : call,
    ),
  );
}

/**
 * @public - native APPA result admission canonicalizes the client-local claim.
 *
 * The client must execute a local handle, while APPA's call ledger retains the
 * proxy handle. This verifies their exact association and restores the ledger
 * representation before normal claimed-call validation.
 */
export async function normalizeNativeCodexWriteStdinArguments(params: {
  scope: NativeWireScope;
  sourceCallId: string;
  proxyArguments: string;
  clientArguments: string;
}): Promise<string> {
  const proxyArguments = parseProxyWriteStdinArguments(params.proxyArguments);
  const clientArguments = parseLocalWriteStdinArguments(params.clientArguments);
  const route = await findRoute({
    scope: params.scope,
    proxySessionId: proxyArguments.session_id,
  });
  if (
    clientArguments.session_id !== route.localSessionId ||
    !sameJson(
      { ...proxyArguments, session_id: route.localSessionId },
      clientArguments,
    )
  ) {
    throw new AppaProxySessionProtocolError(
      "native write_stdin client arguments contradict the owned process route",
    );
  }
  if (
    route.alias.consumedAt !== null &&
    !(await hasClosureReceipt({
      scope: params.scope,
      sourceCallId: params.sourceCallId,
      proxySessionId: proxyArguments.session_id,
      localSessionId: route.localSessionId,
    }))
  ) {
    throw new AppaProxySessionProtocolError(
      "native write_stdin uses a closed process handle",
    );
  }
  return params.proxyArguments;
}

/**
 * @public - native APPA result admission rewrites an already-bound write result.
 *
 * A terminal observation consumes the durable route before the result can be
 * released. The closure receipt makes a retried terminal result idempotent but
 * rejects any later call that attempts to reuse the stale proxy handle.
 */
export async function routeNativeCodexWriteStdinResult(params: {
  scope: NativeWireScope;
  sourceCallId: string;
  proxyArguments: string;
  output: unknown;
}): Promise<{ output: string; outcome: "success" | "failure" }> {
  if (typeof params.output !== "string") {
    throw new AppaProxySessionProtocolError(
      "native write_stdin result is not a shell observation",
    );
  }
  const proxyArguments = parseProxyWriteStdinArguments(params.proxyArguments);
  const route = await findRoute({
    scope: params.scope,
    proxySessionId: proxyArguments.session_id,
  });
  const observation = inspectCodexShellOutput(params.output);
  if (observation.processState === "running") {
    if (
      route.alias.consumedAt !== null ||
      observation.localSessionId !== route.localSessionId
    ) {
      throw new AppaProxySessionProtocolError(
        "native write_stdin result contradicts the active process route",
      );
    }
    return {
      output: rewriteCodexShellHandle({
        output: params.output,
        expectedLocalId: route.localSessionId,
        proxyId: proxyArguments.session_id,
      }),
      outcome: "success",
    };
  }
  if (observation.processState !== "exited") {
    throw new AppaProxySessionProtocolError(
      "native write_stdin process outcome is unknown",
    );
  }
  const closureExists = await hasClosureReceipt({
    scope: params.scope,
    sourceCallId: params.sourceCallId,
    proxySessionId: proxyArguments.session_id,
    localSessionId: route.localSessionId,
  });
  if (!closureExists) {
    if (route.alias.consumedAt !== null) {
      throw new AppaProxySessionProtocolError(
        "native write_stdin uses a closed process handle",
      );
    }
    await AppaProxyWireModel.consumeIssuedAlias({
      ...params.scope,
      aliasId: route.alias.id,
    });
    await recordClosureReceipt({
      ...params,
      proxySessionId: proxyArguments.session_id,
      localSessionId: route.localSessionId,
    });
  }
  if (observation.outcome === "indeterminate") {
    throw new AppaProxySessionProtocolError(
      "native write_stdin process outcome is unknown",
    );
  }
  return { output: params.output, outcome: observation.outcome };
}

// === Internal helpers ===

async function allocateProxySessionId(scope: NativeWireScope): Promise<number> {
  const used = new Set(
    (await AppaProxyWireModel.listIssuedAliases(scope))
      .filter((alias) => alias.kind === "process")
      .map((alias) => alias.wireId),
  );
  for (let attempts = 0; attempts < 64; attempts++) {
    // Stock Codex allocates local process IDs from a positive range. Negative
    // values reserve an unambiguous model-facing namespace for this proxy.
    const candidate = -randomInt(1, 2_147_483_648);
    if (!used.has(String(candidate))) return candidate;
  }
  throw new AppaProxySessionProtocolError(
    "native process handle allocation exhausted",
  );
}

function parseProxySessionId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed >= 0 || parsed < -2_147_483_648) {
    throw new AppaProxySessionProtocolError(
      "stored native process handle is invalid",
    );
  }
  return parsed;
}

async function findActiveRoute(params: {
  scope: NativeWireScope;
  proxySessionId: number;
}) {
  const route = await findRoute(params);
  if (route.alias.consumedAt !== null) {
    throw new AppaProxySessionProtocolError("native process handle is closed");
  }
  return route;
}

async function findRoute(params: {
  scope: NativeWireScope;
  proxySessionId: number;
}) {
  const alias = (await AppaProxyWireModel.listIssuedAliases(params.scope)).find(
    (candidate) =>
      candidate.kind === "process" &&
      candidate.wireId === String(params.proxySessionId) &&
      isProcessRouteMetadata(candidate.metadata),
  );
  if (!alias || !isProcessRouteMetadata(alias.metadata)) {
    throw new AppaProxySessionProtocolError(
      "native process handle is not an issued owned correlation",
    );
  }
  return { alias, localSessionId: alias.metadata.localSessionId };
}

async function hasClosureReceipt(params: {
  scope: NativeWireScope;
  sourceCallId: string;
  proxySessionId: number;
  localSessionId: number;
}): Promise<boolean> {
  return (await AppaProxyWireModel.listIssuedAliases(params.scope)).some(
    (alias) =>
      alias.kind === "process" &&
      alias.logicalId === params.sourceCallId &&
      isClosureMetadata(alias.metadata) &&
      alias.metadata.proxySessionId === params.proxySessionId &&
      alias.metadata.localSessionId === params.localSessionId,
  );
}

async function recordClosureReceipt(params: {
  scope: NativeWireScope;
  sourceCallId: string;
  proxySessionId: number;
  localSessionId: number;
}): Promise<void> {
  const payload = {
    version: 1,
    purpose: "native_process_handle_closed",
    sourceCallId: params.sourceCallId,
    proxySessionId: params.proxySessionId,
    localSessionId: params.localSessionId,
  };
  const frame = await AppaProxyWireModel.createFrame({
    ...params.scope,
    kind: "inbound_hold",
    protocol: "codex-native-process-closure/v1",
    requestHash: JSON.stringify(payload),
    idempotencyKey: `codex-native-process-closure:${params.scope.turnId}:${identifierHash(params.sourceCallId)}`,
    payload,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  await AppaProxyWireModel.addAliases({
    ...params.scope,
    frameId: frame.id,
    aliases: [
      {
        kind: "process",
        position: 0,
        wireId: `closed:${identifierHash(params.sourceCallId)}`,
        logicalId: params.sourceCallId,
        sourceCallId: params.sourceCallId,
        metadata: {
          purpose: "native_process_handle_closed",
          proxySessionId: params.proxySessionId,
          localSessionId: params.localSessionId,
        },
      },
    ],
  });
  await AppaProxyWireModel.markReady({ ...params.scope, frameId: frame.id });
  await AppaProxyWireModel.markIssued({ ...params.scope, frameId: frame.id });
}

function parseProxyWriteStdinArguments(value: string): Record<
  string,
  unknown
> & {
  session_id: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AppaProxySessionProtocolError(
      "native write_stdin arguments are invalid",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Number.isInteger((parsed as { session_id?: unknown }).session_id) ||
    (parsed as { session_id: number }).session_id >= 0 ||
    (parsed as { session_id: number }).session_id < -2_147_483_648
  ) {
    throw new AppaProxySessionProtocolError(
      "native write_stdin must use a proxy process handle",
    );
  }
  return parsed as Record<string, unknown> & { session_id: number };
}

function parseLocalWriteStdinArguments(value: string): Record<
  string,
  unknown
> & {
  session_id: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AppaProxySessionProtocolError(
      "native write_stdin client arguments are invalid",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Number.isInteger((parsed as { session_id?: unknown }).session_id) ||
    (parsed as { session_id: number }).session_id < 0 ||
    (parsed as { session_id: number }).session_id > 2_147_483_647
  ) {
    throw new AppaProxySessionProtocolError(
      "native write_stdin client arguments need a local process handle",
    );
  }
  return parsed as Record<string, unknown> & { session_id: number };
}

function isProcessRouteMetadata(value: unknown): value is {
  purpose: "native_process_handle_correlation";
  localSessionId: number;
} {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { purpose?: unknown }).purpose ===
      "native_process_handle_correlation" &&
    Number.isInteger((value as { localSessionId?: unknown }).localSessionId) &&
    (value as { localSessionId: number }).localSessionId >= 0
  );
}

function isClosureMetadata(value: unknown): value is {
  purpose: "native_process_handle_closed";
  proxySessionId: number;
  localSessionId: number;
} {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { purpose?: unknown }).purpose ===
      "native_process_handle_closed" &&
    Number.isInteger((value as { proxySessionId?: unknown }).proxySessionId) &&
    Number.isInteger((value as { localSessionId?: unknown }).localSessionId)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_name, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });
}

function identifierHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
