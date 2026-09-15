import { createHmac, randomUUID } from "node:crypto";
import config from "@/config";
import {
  default as AppaOpaqueHistoryModel,
  AppaOpaqueHistoryModelError,
} from "@/models/appa-opaque-history";
import type {
  AppaOpaqueHistoryMode,
  AppaOpaqueHistorySafePresentation,
  AppaOpaqueHistoryScope,
  AppaOpaqueHistoryTrigger,
  AppaOpaqueHistoryWindowRef,
} from "@/types";
import {
  decryptStringWithKey,
  deriveKeyFromSecret,
  encryptStringWithKey,
} from "@/utils/crypto";

const ENCRYPTION_DOMAIN = "archestra-appa-opaque-history-encryption-v1";
const IDENTITY_DOMAIN = "archestra-appa-opaque-history-identity-v1";
const MAX_CANONICAL_ITEM_BYTES = 256 * 1024;

export class AppaOpaqueHistoryError extends Error {
  readonly quarantineRequired: boolean;

  constructor(
    readonly code:
      | "invalid_item"
      | "duplicate_item"
      | "unknown_item"
      | "cross_scope_item"
      | "unauthorized_lineage"
      | "compaction_not_ready"
      | "storage_limit"
      | "persistence_uncertain",
  ) {
    super(code.replaceAll("_", " "));
    this.name = "AppaOpaqueHistoryError";
    // A storage or cryptographic failure after the request boundary is unsafe
    // to retry. The parent must quarantine the APPA session before returning.
    this.quarantineRequired = code === "persistence_uncertain";
  }
}

type AppaOpaqueHistoryPreparedCompaction = {
  safePresentations: AppaOpaqueHistorySafePresentation[];
};

/** Checks that APPA can compact without an in-flight external call. */
export async function prepareCompaction(params: {
  scope: AppaOpaqueHistoryScope;
  trigger: AppaOpaqueHistoryTrigger;
  claimedTurnId?: string;
}): Promise<AppaOpaqueHistoryPreparedCompaction> {
  try {
    const state = await AppaOpaqueHistoryModel.getCompactionState(params.scope);
    if (
      !state ||
      state.outstandingCallCount > 0 ||
      state.sessionState === "quarantined" ||
      (params.trigger === "manual" &&
        state.sessionState !== "ready" &&
        !(
          state.sessionState === "in_turn" &&
          params.claimedTurnId === state.activeTurnId
        ))
    ) {
      throw new AppaOpaqueHistoryError("compaction_not_ready");
    }
    return { safePresentations: state.safePresentations };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Enumerates the only provider-item shapes the issuer ledger can safely
 * observe. Unknown encrypted fields are rejected rather than forwarded as
 * untracked opaque state.
 */
export function collectOpaqueHistoryItems(
  items: readonly unknown[],
): Record<string, unknown>[] {
  return items.flatMap((value) => {
    if (!isPlainObject(value)) return [];
    if (typeof value.type !== "string" || !isKnownOpaqueType(value.type)) {
      if (containsOpaqueMarker(value)) {
        throw new AppaOpaqueHistoryError("invalid_item");
      }
      return [];
    }
    if (hasKnownOpaqueField(value)) return [value];
    if (containsOpaqueMarker(value)) {
      throw new AppaOpaqueHistoryError("invalid_item");
    }
    return [];
  });
}

/**
 * Validates client-supplied opaque history before APPA admission. A compact
 * replay is the only event allowed to bind an as-yet unknown client window.
 */
export async function validateInboundOpaqueItems(params: {
  scope: AppaOpaqueHistoryScope;
  mode: AppaOpaqueHistoryMode;
  sourceWindow: AppaOpaqueHistoryWindowRef;
  items: Record<string, unknown>[];
}): Promise<Record<string, unknown>[]> {
  if (!isMode(params.mode) || !isWindowRef(params.sourceWindow)) {
    throw new AppaOpaqueHistoryError("invalid_item");
  }
  const parsedItems = params.items.map(parseInboundOpaqueItem);
  rejectRequestDuplicates(params.scope, parsedItems);

  try {
    let state = await AppaOpaqueHistoryModel.getInboundState(params.scope);
    let currentWindow = findExactWindow(state.windows, params.sourceWindow);
    if (!currentWindow) {
      if (params.mode === "inference" && state.windows.length === 0) {
        if (parsedItems.length === 0) {
          // A first native inference turn has no issued opaque state to replay.
          return [];
        }
        throw new AppaOpaqueHistoryError("unauthorized_lineage");
      }
      const storedItems = parsedItems.map((item) =>
        matchStoredItem({ scope: params.scope, items: state.items, item }),
      );
      const compactionTokens = storedItems.filter(
        (item) => item.itemType === "compaction",
      );
      if (compactionTokens.length !== 1) {
        throw new AppaOpaqueHistoryError("unauthorized_lineage");
      }
      await AppaOpaqueHistoryModel.bindCompactionSuccessor({
        scope: params.scope,
        sourceWindow: params.sourceWindow,
        tokenServerIdentity: compactionTokens[0].serverIdentity,
      });
      state = await AppaOpaqueHistoryModel.getInboundState(params.scope);
      currentWindow = findExactWindow(state.windows, params.sourceWindow);
      if (!currentWindow)
        throw new AppaOpaqueHistoryError("persistence_uncertain");
    }

    const storedItems = parsedItems.map((item) =>
      matchStoredItem({ scope: params.scope, items: state.items, item }),
    );

    const authorizedWindowIds = ancestorWindowIds(
      state.windows,
      currentWindow.id,
    );
    return storedItems.map((stored) => {
      if (!authorizedWindowIds.has(stored.windowId)) {
        throw new AppaOpaqueHistoryError("unauthorized_lineage");
      }
      return decryptStoredItem({
        scope: params.scope,
        serverIdentity: stored.serverIdentity,
        encryptedPayload: stored.canonicalPayloadEncrypted,
      });
    });
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Records every recognized provider-issued opaque item before its response is
 * written to the client. It retains the complete canonical provider object and
 * never assigns a provider ID where the provider omitted one.
 */
export async function recordIssuedResponseItems(params: {
  scope: AppaOpaqueHistoryScope;
  mode: AppaOpaqueHistoryMode;
  trigger?: AppaOpaqueHistoryTrigger;
  sourceWindow: AppaOpaqueHistoryWindowRef;
  responseItems: Record<string, unknown>[];
  maxItems: number;
  maxBytes: number;
}): Promise<void> {
  if (
    !isMode(params.mode) ||
    !isWindowRef(params.sourceWindow) ||
    !isPositiveSafeInteger(params.maxItems) ||
    !isPositiveSafeInteger(params.maxBytes)
  ) {
    throw new AppaOpaqueHistoryError("invalid_item");
  }

  const items = collectOpaqueHistoryItems(params.responseItems).map(
    parseInboundOpaqueItem,
  );
  if (
    params.mode !== "inference" &&
    items.filter((item) => item.type === "compaction").length !== 1
  ) {
    throw new AppaOpaqueHistoryError("invalid_item");
  }
  rejectRequestDuplicates(params.scope, items);

  try {
    await AppaOpaqueHistoryModel.recordIssuedItems({
      scope: params.scope,
      trigger: params.trigger,
      sourceWindow: params.sourceWindow,
      maxItems: params.maxItems,
      maxBytes: params.maxBytes,
      requireCompactionReady: params.mode !== "inference",
      items: items.map((item) => {
        const serverIdentity = randomUUID();
        return {
          providerItemId: item.providerItemId,
          serverIdentity,
          itemType: item.type,
          identityHash: identityFor(params.scope, item.canonicalPayload),
          canonicalPayloadEncrypted: encryptStringWithKey(
            item.canonicalPayload,
            encryptionKey(),
            itemAad(params.scope, serverIdentity),
          ),
          canonicalPayloadBytes: item.canonicalPayloadBytes,
        };
      }),
    });
  } catch (error) {
    throw mapError(error);
  }
}

// === Internal helpers ===

function parseInboundOpaqueItem(
  value: Record<string, unknown>,
): ParsedOpaqueItem {
  return parseKnownOpaqueItem(value, true);
}

function parseKnownOpaqueItem(
  value: Record<string, unknown>,
  requireOpaqueField: boolean,
): ParsedOpaqueItem {
  if (
    !isPlainObject(value) ||
    containsCredentialField(value) ||
    typeof value.type !== "string" ||
    !isKnownOpaqueType(value.type) ||
    ("id" in value &&
      (typeof value.id !== "string" || value.id.length === 0)) ||
    (requireOpaqueField && !hasKnownOpaqueField(value))
  ) {
    throw new AppaOpaqueHistoryError("invalid_item");
  }
  const canonicalPayload = stableStringify(value);
  const canonicalPayloadBytes = Buffer.byteLength(canonicalPayload, "utf8");
  if (canonicalPayloadBytes > MAX_CANONICAL_ITEM_BYTES) {
    throw new AppaOpaqueHistoryError("invalid_item");
  }
  return {
    providerItemId: typeof value.id === "string" ? value.id : null,
    type: value.type,
    canonicalPayload,
    canonicalPayloadBytes,
  };
}

function hasKnownOpaqueField(value: Record<string, unknown>): boolean {
  if (value.type === "reasoning" || value.type === "compaction") {
    return nonEmptyString(value.encrypted_content);
  }
  if (value.type === "function_call" || value.type === "custom_tool_call") {
    return (
      nonEmptyString(value.encrypted_function_args) ||
      nestedEncryptedContent(value.arguments)
    );
  }
  return (
    nonEmptyString(value.encrypted_function_output) ||
    nestedEncryptedContent(value.output)
  );
}

function nestedEncryptedContent(value: unknown): boolean {
  return isPlainObject(value) && nonEmptyString(value.encrypted_content);
}

function containsOpaqueMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsOpaqueMarker);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      [
        "encrypted_content",
        "encrypted_function_args",
        "encrypted_function_output",
      ].includes(key) || containsOpaqueMarker(child),
  );
}

function isKnownOpaqueType(type: string): boolean {
  return [
    "reasoning",
    "compaction",
    "function_call",
    "custom_tool_call",
    "function_call_output",
    "custom_tool_call_output",
  ].includes(type);
}

function matchStoredItem(params: {
  scope: AppaOpaqueHistoryScope;
  items: Array<{
    providerItemId: string | null;
    identityHash: string;
    itemType: string;
    serverIdentity: string;
    windowId: string;
    canonicalPayloadEncrypted: string;
  }>;
  item: ParsedOpaqueItem;
}) {
  const identityHashes = inboundIdentityHashes(params.scope, params.item);
  const byIdentity = params.items.find((candidate) =>
    identityHashes.includes(candidate.identityHash),
  );
  if (params.item.providerItemId !== null) {
    const byProviderId = params.items.find(
      (candidate) => candidate.providerItemId === params.item.providerItemId,
    );
    if (!byProviderId) {
      if (byIdentity) throw new AppaOpaqueHistoryError("cross_scope_item");
      throw new AppaOpaqueHistoryError("unknown_item");
    }
    if (
      !identityHashes.includes(byProviderId.identityHash) ||
      byProviderId.itemType !== params.item.type
    ) {
      throw new AppaOpaqueHistoryError("cross_scope_item");
    }
    return byProviderId;
  }
  if (!byIdentity) throw new AppaOpaqueHistoryError("unknown_item");
  if (
    byIdentity.providerItemId !== null ||
    byIdentity.itemType !== params.item.type
  ) {
    throw new AppaOpaqueHistoryError("cross_scope_item");
  }
  return byIdentity;
}

function rejectRequestDuplicates(
  scope: AppaOpaqueHistoryScope,
  items: ParsedOpaqueItem[],
): void {
  const providerIds = new Set<string>();
  const identities = new Set<string>();
  for (const item of items) {
    const hashes = inboundIdentityHashes(scope, item);
    if (
      hashes.some((identity) => identities.has(identity)) ||
      (item.providerItemId !== null && providerIds.has(item.providerItemId))
    ) {
      throw new AppaOpaqueHistoryError("duplicate_item");
    }
    for (const identity of hashes) identities.add(identity);
    if (item.providerItemId !== null) providerIds.add(item.providerItemId);
  }
}

function inboundIdentityHashes(
  scope: AppaOpaqueHistoryScope,
  item: ParsedOpaqueItem,
): string[] {
  const hashes = [identityFor(scope, item.canonicalPayload)];
  if (item.type !== "reasoning") return hashes;
  const payload = JSON.parse(item.canonicalPayload) as Record<string, unknown>;
  // Stock Codex preserves encrypted reasoning but serializes empty optional
  // content as absent, null, or []. These are transport-equivalent only when
  // the field is empty; non-empty reasoning content remains exact-bound.
  if (
    Object.hasOwn(payload, "content") &&
    payload.content !== null &&
    (!Array.isArray(payload.content) || payload.content.length !== 0)
  ) {
    return hashes;
  }
  for (const content of [undefined, null, []] as const) {
    const candidate = { ...payload };
    if (content === undefined) delete candidate.content;
    else candidate.content = content;
    const identity = identityFor(scope, stableStringify(candidate));
    if (!hashes.includes(identity)) hashes.push(identity);
  }
  return hashes;
}

function findExactWindow<
  Window extends {
    providerWindowId: string;
    frameVersion: number;
    sourceTurnId: string;
  },
>(
  windows: Window[],
  sourceWindow: AppaOpaqueHistoryWindowRef,
): Window | undefined {
  const window = windows.find(
    (candidate) => candidate.providerWindowId === sourceWindow.providerWindowId,
  );
  if (window && window.frameVersion !== sourceWindow.frameVersion) {
    throw new AppaOpaqueHistoryError("unauthorized_lineage");
  }
  return window;
}

function ancestorWindowIds(
  windows: Array<{ id: string; parentWindowId: string | null }>,
  currentWindowId: string,
): Set<string> {
  const authorized = new Set<string>();
  let cursor: string | null = currentWindowId;
  while (cursor) {
    if (authorized.has(cursor))
      throw new AppaOpaqueHistoryError("persistence_uncertain");
    authorized.add(cursor);
    const window = windows.find((candidate) => candidate.id === cursor);
    if (!window) throw new AppaOpaqueHistoryError("persistence_uncertain");
    cursor = window.parentWindowId;
  }
  return authorized;
}

function decryptStoredItem(params: {
  scope: AppaOpaqueHistoryScope;
  serverIdentity: string;
  encryptedPayload: string;
}): Record<string, unknown> {
  try {
    const plaintext = decryptStringWithKey(
      params.encryptedPayload,
      encryptionKey(),
      itemAad(params.scope, params.serverIdentity),
    );
    const value: unknown = JSON.parse(plaintext);
    if (!isPlainObject(value))
      throw new Error("stored payload is not an object");
    return value;
  } catch (error) {
    if (error instanceof AppaOpaqueHistoryError) throw error;
    throw new AppaOpaqueHistoryError("persistence_uncertain");
  }
}

function identityFor(
  scope: AppaOpaqueHistoryScope,
  canonicalPayload: string,
): string {
  return createHmac("sha256", identityKey())
    .update(identityAad(scope))
    .update("\n")
    .update(canonicalPayload)
    .digest("hex");
}

function identityAad(scope: AppaOpaqueHistoryScope): string {
  return [
    "appa-opaque-history-item-v2",
    scope.sessionId,
    scope.ownerScopeHash,
    scope.provider,
    scope.protocol,
    scope.model,
  ].join("|");
}

function itemAad(
  scope: AppaOpaqueHistoryScope,
  serverIdentity: string,
): string {
  return [identityAad(scope), "issuer", serverIdentity].join("|");
}

function encryptionKey(): Buffer {
  return deriveKeyFromSecret(requiredEncryptionSecret(), ENCRYPTION_DOMAIN);
}

function identityKey(): Buffer {
  return deriveKeyFromSecret(requiredEncryptionSecret(), IDENTITY_DOMAIN);
}

function requiredEncryptionSecret(): string {
  const secret = config.secretsManager.encryptionSecret;
  if (!secret) throw new AppaOpaqueHistoryError("persistence_uncertain");
  return secret;
}

function mapError(error: unknown): AppaOpaqueHistoryError {
  if (error instanceof AppaOpaqueHistoryError) return error;
  if (error instanceof AppaOpaqueHistoryModelError) {
    switch (error.code) {
      case "storage_limit":
        return new AppaOpaqueHistoryError("storage_limit");
      case "duplicate_item":
        return new AppaOpaqueHistoryError("duplicate_item");
      case "unknown_item":
        return new AppaOpaqueHistoryError("unknown_item");
      case "unknown_session":
      case "window_lineage_changed":
        return new AppaOpaqueHistoryError("unauthorized_lineage");
      case "manual_turn_active":
      case "outstanding_calls":
        return new AppaOpaqueHistoryError("compaction_not_ready");
    }
  }
  return new AppaOpaqueHistoryError("persistence_uncertain");
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(
        key,
      ) || containsCredentialField(child),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMode(value: string): value is AppaOpaqueHistoryMode {
  return (
    value === "inference" || value === "compactv1" || value === "compactv2"
  );
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isWindowRef(value: unknown): value is AppaOpaqueHistoryWindowRef {
  return (
    isPlainObject(value) &&
    nonEmptyString(value.providerWindowId) &&
    nonEmptyString(value.sourceTurnId) &&
    typeof value.frameVersion === "number" &&
    Number.isSafeInteger(value.frameVersion) &&
    value.frameVersion >= 0
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

type ParsedOpaqueItem = {
  providerItemId: string | null;
  type: string;
  canonicalPayload: string;
  canonicalPayloadBytes: number;
};
