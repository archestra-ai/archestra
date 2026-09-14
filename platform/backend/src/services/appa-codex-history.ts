import logger from "@/logging";
import { AppaProxySessionProtocolError } from "@/models/appa-proxy-session";
import type { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import { AppaProxyHookError } from "@/routes/proxy/appa-proxy-hook";
import type {
  AppaOpaqueHistoryScope,
  AppaOpaqueHistoryWindowRef,
} from "@/types";
import { restoreNativeCodexProviderIds } from "./appa-codex-native-bridge";
import {
  AppaOpaqueHistoryError,
  collectOpaqueHistoryItems,
  prepareCompaction,
  recordIssuedResponseItems,
  validateInboundOpaqueItems,
} from "./appa-opaque-history";

export type NativeCodexHistory = {
  scope: AppaOpaqueHistoryScope;
  sourceWindow: AppaOpaqueHistoryWindowRef;
  mode: "inference" | "compactv1" | "compactv2";
  trigger?: "automatic" | "manual";
};

export async function validateNativeCodexHistory(params: {
  session: AppaProxyHookSession;
  request: unknown;
  headers: Record<string, unknown>;
  provider: string;
  principalUserId?: string;
  legacyCompact?: boolean;
}): Promise<NativeCodexHistory> {
  const scope = params.session.getNativeWireScope();
  const body = object(params.request);
  const metadataHeader = params.headers["x-codex-turn-metadata"];
  let metadata: Record<string, unknown> = {};
  if (typeof metadataHeader === "string") {
    try {
      metadata = object(JSON.parse(metadataHeader));
    } catch {
      throw new AppaProxySessionProtocolError("Invalid Codex turn metadata");
    }
  }
  const version =
    typeof metadata.window_number === "number" &&
    Number.isSafeInteger(metadata.window_number) &&
    metadata.window_number >= 0
      ? metadata.window_number
      : 0;
  const currentWindow =
    metadata.window_id ??
    params.headers["x-codex-window-id"] ??
    metadata.context_window_id;
  const history: NativeCodexHistory = {
    mode: params.legacyCompact
      ? "compactv1"
      : Array.isArray(body.input) &&
          body.input.some((item) => object(item).type === "compaction_trigger")
        ? "compactv2"
        : "inference",
    scope: {
      sessionId: scope.sessionId,
      ownerScopeHash: scope.ownerScopeHash,
      provider: params.provider,
      protocol: "codex-responses",
      model: typeof body.model === "string" ? body.model : "",
    },
    sourceWindow: {
      providerWindowId:
        typeof currentWindow === "string"
          ? currentWindow
          : `session:${scope.sessionId}:initial`,
      frameVersion: version,
      sourceTurnId:
        typeof metadata.turn_id === "string" ? metadata.turn_id : scope.turnId,
    },
  };
  const compaction = object(metadata.compaction);
  if (history.mode !== "inference") {
    history.trigger = compaction.trigger === "manual" ? "manual" : "automatic";
    const prepared = await prepareCompaction({
      scope: history.scope,
      trigger: history.trigger,
      claimedTurnId: scope.turnId,
    });
    const presentations = new Map(
      prepared.safePresentations.map((item) => [
        item.callId,
        item.presentation,
      ]),
    );
    if (Array.isArray(body.input)) {
      body.input = body.input.map((item) => {
        const value = object(item);
        const safe =
          typeof value.call_id === "string"
            ? presentations.get(value.call_id)
            : undefined;
        return value.type === "function_call_output" && safe !== undefined
          ? { ...value, output: safe }
          : item;
      });
    }
  }
  const restored = object(
    await restoreNativeCodexProviderIds({
      session: params.session,
      request: params.request,
      principalUserId: params.principalUserId,
    }),
  );
  const input = Array.isArray(restored.input)
    ? restored.input.filter((item) => {
        const type = object(item).type;
        // The restore step above has already verified and atomically claimed
        // these client-only frames from an issued response. Keep their opaque
        // provider wire intact rather than routing them through history gates.
        return (
          type !== "additional_tools" &&
          type !== "tool_search_call" &&
          type !== "tool_search_output"
        );
      })
    : [];
  try {
    const items = collectOpaqueHistoryItems(input);
    const canonical = await validateInboundOpaqueItems({
      ...history,
      items,
    });
    const originalInput = Array.isArray(body.input) ? body.input : [];
    const restoredInput = Array.isArray(restored.input) ? restored.input : [];
    for (let i = 0; i < items.length; i++) {
      const index = restoredInput.indexOf(items[i]);
      if (index < 0) throw new AppaOpaqueHistoryError("invalid_item");
      const clientItem = object(originalInput[index]);
      originalInput[index] = {
        ...canonical[i],
        ...(clientItem.id === undefined ? {} : { id: clientItem.id }),
        ...(clientItem.call_id === undefined
          ? {}
          : { call_id: clientItem.call_id }),
      };
    }
  } catch (error) {
    logger.error(
      { err: error, stage: "native_codex_inbound_history" },
      "OpenAPPA native Codex inbound history validation failed",
    );
    if (error instanceof AppaOpaqueHistoryError && error.quarantineRequired)
      throw new AppaProxyHookError("unavailable", "input");
    throw new AppaProxySessionProtocolError(
      "Opaque Codex history has no valid issued binding",
    );
  }
  return history;
}

export async function persistNativeCodexHistory(params: {
  history: NativeCodexHistory;
  response: unknown;
}): Promise<void> {
  const response = object(params.response);
  try {
    await recordIssuedResponseItems({
      ...params.history,
      mode: params.history.mode,
      trigger: params.history.trigger,
      responseItems: Array.isArray(response.output)
        ? response.output.filter(
            (item): item is Record<string, unknown> =>
              !!item && typeof item === "object" && !Array.isArray(item),
          )
        : [],
      maxItems: 4096,
      maxBytes: 64 * 1024 * 1024,
    });
  } catch (error) {
    // Preserve the sealed provider-history failure for backend diagnosis while
    // retaining the fail-closed hook result at the client boundary.
    logger.error(
      { err: error, stage: "native_codex_history_persistence" },
      "OpenAPPA native Codex history persistence failed",
    );
    throw new AppaProxyHookError("unavailable", "outbound");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
