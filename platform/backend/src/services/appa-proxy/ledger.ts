import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppaCheckpoint } from "@/clients/appa-runtime/types";
import config from "@/config";
import AppaNativeChildCorrelationModel from "@/models/appa-native-child-correlation";
import AppaProxyLedgerModel, {
  type AppaProxyForkLookupScope,
  type AppaProxyLedgerScope,
} from "@/models/appa-proxy";
import type { AppaCanonicalRequestHistory } from "@/services/appa-history-codec";
import type { AppaCompletedResponseFrame } from "@/services/appa-response-frame";
import {
  decryptStringWithKey,
  deriveKeyFromSecret,
  encryptStringWithKey,
} from "@/utils/crypto";

class AppaProxyLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppaProxyLedgerError";
  }
}

type AppaCheckpointFork = {
  sourceSessionId: string;
  sourceFrameId: string;
  runtimeEventId: string;
  checkpointId: string;
  checkpointPosition: number;
  checkpointDigest: string;
  issuedItemsDigest: string;
  terminalOmission: boolean;
};

type PreparedChildCarrier = {
  carrier: string;
  rewrittenArguments: Record<string, unknown>;
  rewrittenArgumentsCanonical: string;
};

/**
 * Scoped provider/client correlation only. Runtime policy and durable receipt
 * decisions remain in the authenticated APPA runtime and existing session
 * models; no caller may supply an unbound client scope.
 *
 * @public — consumed by the main APPA proxy handler.
 */
export class AppaProxyLedger {
  constructor(
    private readonly scope: AppaProxyLedgerScope | AppaProxyForkLookupScope,
  ) {}

  static forForkLookup(scope: AppaProxyForkLookupScope): AppaProxyLedger {
    return new AppaProxyLedger(scope);
  }

  async singleCall(callId: string): Promise<{
    callId: string;
    dispatchId: string | null;
    spawnBinding: string | null;
    emittedArgumentsCanonical: string;
  }> {
    const call = await AppaProxyLedgerModel.findSingleCall({
      ...this.sessionScope(),
      callId,
    });
    if (!call || call.state !== "open") {
      throw new AppaProxyLedgerError(
        "provider call is not an admitted single-call correlation",
      );
    }
    return call;
  }

  async prepareChildCarrier(params: {
    callId: string;
    originalArguments: Record<string, unknown>;
  }): Promise<PreparedChildCarrier> {
    const call = await AppaProxyLedgerModel.findSingleCall({
      ...this.sessionScope(),
      callId: params.callId,
    });
    const originalArgumentsCanonical = canonicalJson(params.originalArguments);
    if (
      !call ||
      call.state !== "authorization_intent" ||
      call.emittedArgumentsCanonical !== originalArgumentsCanonical
    ) {
      throw new AppaProxyLedgerError(
        "child carrier must bind the exact pending provider spawn call",
      );
    }
    const prompt = params.originalArguments.prompt;
    if (typeof prompt !== "string" || prompt.includes("apc1.")) {
      throw new AppaProxyLedgerError(
        "child carrier requires an unmarked documented prompt field",
      );
    }
    const originalHash = fingerprint(originalArgumentsCanonical);
    const signature = this.sign(
      [
        "apc1",
        this.sessionScope().sessionId,
        this.scope.ownerScopeHash,
        this.scope.profileId,
        call.callId,
        originalHash,
      ].join("."),
    );
    const carrier = `apc1.${call.callId}.${originalHash}.${signature}`;
    const rewrittenArguments = {
      ...params.originalArguments,
      prompt: `${carrier}\n${prompt}`,
    };
    return {
      carrier,
      rewrittenArguments,
      rewrittenArgumentsCanonical: canonicalJson(rewrittenArguments),
    };
  }

  async resolveChildCarrier(params: {
    parentClientSessionId: string;
    callId: string;
    carrier: string;
  }): Promise<string> {
    const call = await this.singleCall(params.callId);
    const parsedCarrier = parseCarrier(params.carrier);
    if (
      !call.spawnBinding ||
      !parsedCarrier ||
      parsedCarrier.callId !== call.callId
    ) {
      throw new AppaProxyLedgerError(
        "child did not present a valid proxy-issued spawn carrier",
      );
    }
    const expected = this.sign(
      [
        "apc1",
        this.sessionScope().sessionId,
        this.scope.ownerScopeHash,
        this.scope.profileId,
        call.callId,
        parsedCarrier.originalHash,
      ].join("."),
    );
    if (!safeEqual(parsedCarrier.signature, expected)) {
      throw new AppaProxyLedgerError(
        "child spawn carrier does not bind the exact released provider call",
      );
    }
    if (
      !releasedArgumentsContainCarrier(
        call.emittedArgumentsCanonical,
        params.carrier,
        parsedCarrier.originalHash,
      )
    ) {
      throw new AppaProxyLedgerError(
        "released provider spawn arguments do not match the prepared carrier insertion",
      );
    }
    if (!params.parentClientSessionId) {
      throw new AppaProxyLedgerError("child carrier requires a parent locator");
    }
    const parent =
      await AppaNativeChildCorrelationModel.findOwnedParentByClient({
        ownerScopeHash: this.scope.ownerScopeHash,
        profileId: this.scope.profileId,
        parentClientSessionId: params.parentClientSessionId,
      });
    if (parent.id !== this.sessionScope().sessionId) {
      throw new AppaProxyLedgerError(
        "child carrier parent locator does not match its authenticated session",
      );
    }
    return call.spawnBinding;
  }

  async recordCheckpointBinding(params: {
    checkpoint: AppaCheckpoint;
    /** Completed output from AppaResponseFrame.complete(). */
    frame: AppaCompletedResponseFrame;
  }): Promise<AppaCheckpointFork> {
    const envelope = canonicalJson({
      requestPrefix: params.frame.requestPrefix,
      inheritedPrefix: params.frame.inheritedPrefix,
    });
    const historyHash = fingerprint(envelope);
    const requestPrefixHash = fingerprint(
      canonicalJson(params.frame.requestPrefix),
    );
    const inheritedPrefixHash = fingerprint(
      canonicalJson(params.frame.inheritedPrefix),
    );
    const historyCiphertext = encryptStringWithKey(
      envelope,
      encryptionKey(),
      checkpointAad(this.sessionScope(), params.checkpoint.checkpoint_id),
    );
    const created = await AppaProxyLedgerModel.createCheckpointBinding({
      ...this.sessionScope(),
      sourceFrameId: params.frame.sourceFrameId,
      runtimeEventId: params.frame.runtimeEventId,
      checkpointId: params.checkpoint.checkpoint_id,
      checkpointPosition: params.checkpoint.position,
      checkpointDigest: params.checkpoint.digest,
      provider: params.frame.provider,
      protocol: params.frame.protocol,
      model: params.frame.model,
      bootstrapDigest: params.frame.bootstrapDigest,
      requestPrefixHash,
      inheritedPrefixHash,
      historyCiphertext,
      historyHash,
      historyBytes: Buffer.byteLength(envelope),
      issuedItemsDigest: params.frame.issuedItemsDigest,
      actualResponseHash: params.frame.receiptHash,
      terminalOmission: params.frame.terminalOmission,
    });
    const binding =
      created ??
      (await AppaProxyLedgerModel.findCheckpointBinding({
        ...this.sessionScope(),
        checkpointId: params.checkpoint.checkpoint_id,
      }));
    if (!binding || !sameCheckpointBinding(binding, params, historyHash)) {
      throw new AppaProxyLedgerError(
        "runtime checkpoint identity was reused with different provider history",
      );
    }
    return checkpointForkFromBinding(binding);
  }

  async matchingCheckpointFork(params: {
    provider: string;
    model: string;
    /** Canonical output of AppaHistoryCodec.request(); never raw provider input. */
    history: Pick<
      AppaCanonicalRequestHistory,
      "protocol" | "history" | "bootstrapDigest"
    >;
  }): Promise<AppaCheckpointFork | null> {
    const candidates = await AppaProxyLedgerModel.listCheckpointBindings({
      ownerScopeHash: this.scope.ownerScopeHash,
      profileId: this.scope.profileId,
      provider: params.provider,
      protocol: params.history.protocol,
      model: params.model,
      bootstrapDigest: params.history.bootstrapDigest,
    });
    const matches: AppaCheckpointFork[] = [];
    for (const { binding } of candidates) {
      const decrypted = decryptStringWithKey(
        binding.historyCiphertext,
        encryptionKey(),
        checkpointAad(
          {
            ...this.scope,
            sessionId: binding.sourceSessionId,
          },
          binding.checkpointId,
        ),
      );
      const envelope = parseEnvelope(decrypted);
      if (
        exactForkHistory(
          params.history.history,
          envelope.requestPrefix,
          envelope.inheritedPrefix,
          binding.terminalOmission,
        )
      ) {
        matches.push(checkpointForkFromBinding(binding));
      }
    }
    if (matches.length > 1) {
      throw new AppaProxyLedgerError(
        "provider history ambiguously matches multiple durable checkpoints",
      );
    }
    return matches[0] ?? null;
  }

  private sign(value: string): string {
    return createHmac("sha256", stableSecret()).update(value).digest("hex");
  }

  private sessionScope(): AppaProxyLedgerScope {
    if (!("sessionId" in this.scope)) {
      throw new AppaProxyLedgerError(
        "operation requires an admitted source session scope",
      );
    }
    return this.scope;
  }
}

function checkpointForkFromBinding(binding: {
  sourceSessionId: string;
  sourceFrameId: string;
  runtimeEventId: string;
  checkpointId: string;
  checkpointPosition: number;
  checkpointDigest: string;
  issuedItemsDigest: string;
  terminalOmission: boolean;
}): AppaCheckpointFork {
  return {
    sourceSessionId: binding.sourceSessionId,
    sourceFrameId: binding.sourceFrameId,
    runtimeEventId: binding.runtimeEventId,
    checkpointId: binding.checkpointId,
    checkpointPosition: binding.checkpointPosition,
    checkpointDigest: binding.checkpointDigest,
    issuedItemsDigest: binding.issuedItemsDigest,
    terminalOmission: binding.terminalOmission,
  };
}

function sameCheckpointBinding(
  binding: {
    sourceFrameId: string;
    runtimeEventId: string;
    checkpointPosition: number;
    checkpointDigest: string;
    provider: string;
    protocol: string;
    model: string;
    bootstrapDigest: string | null;
    issuedItemsDigest: string;
    actualResponseHash: string;
    terminalOmission: boolean;
    historyHash: string;
  },
  params: {
    checkpoint: Pick<AppaCheckpoint, "position" | "digest">;
    frame: AppaCompletedResponseFrame;
  },
  historyHash: string,
): boolean {
  return (
    binding.sourceFrameId === params.frame.sourceFrameId &&
    binding.runtimeEventId === params.frame.runtimeEventId &&
    binding.checkpointPosition === params.checkpoint.position &&
    binding.checkpointDigest === params.checkpoint.digest &&
    binding.provider === params.frame.provider &&
    binding.protocol === params.frame.protocol &&
    binding.model === params.frame.model &&
    binding.bootstrapDigest === params.frame.bootstrapDigest &&
    binding.issuedItemsDigest === params.frame.issuedItemsDigest &&
    binding.actualResponseHash === params.frame.receiptHash &&
    binding.terminalOmission === params.frame.terminalOmission &&
    binding.historyHash === historyHash
  );
}

function exactForkHistory(
  requestHistory: unknown[],
  requestPrefix: unknown[],
  inheritedPrefix: unknown[],
  terminalOmission: boolean,
): boolean {
  if (
    requestHistory.length > inheritedPrefix.length &&
    samePrefix(requestHistory, inheritedPrefix) &&
    freshUserMessages(requestHistory.slice(inheritedPrefix.length))
  ) {
    return true;
  }
  return (
    terminalOmission &&
    requestHistory.length >= requestPrefix.length &&
    samePrefix(requestHistory, requestPrefix) &&
    freshUserMessages(requestHistory.slice(requestPrefix.length))
  );
}

function samePrefix(history: unknown[], prefix: unknown[]): boolean {
  if (history.length < prefix.length) return false;
  return prefix.every(
    (item, index) => canonicalJson(history[index]) === canonicalJson(item),
  );
}

function freshUserMessages(items: unknown[]): boolean {
  return items.every(
    (item) =>
      isRecord(item) &&
      item.type === "message" &&
      item.role === "user" &&
      Array.isArray(item.content) &&
      item.content.every((part) => isRecord(part) && part.type === "text"),
  );
}

function parseEnvelope(value: string): {
  requestPrefix: unknown[];
  inheritedPrefix: unknown[];
} {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isRecord(parsed) ||
      !Array.isArray(parsed.requestPrefix) ||
      !Array.isArray(parsed.inheritedPrefix)
    ) {
      throw new Error("invalid envelope");
    }
    return parsed as { requestPrefix: unknown[]; inheritedPrefix: unknown[] };
  } catch {
    throw new AppaProxyLedgerError("durable checkpoint history is corrupted");
  }
}

function canonicalJson(value: unknown): string {
  const result = JSON.stringify(value, (_name, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });
  if (result === undefined) {
    throw new AppaProxyLedgerError("checkpoint history is not serializable");
  }
  return result;
}

function fingerprint(value: string): string {
  return createHmac("sha256", fingerprintKey()).update(value).digest("hex");
}

function stableSecret(): string {
  const secret = config.llmProxy.appaHook?.sessionHmacSecret;
  if (!secret) {
    throw new AppaProxyLedgerError(
      "checkpoint correlation requires a stable configured session secret",
    );
  }
  return secret;
}

function encryptionKey() {
  return deriveKeyFromSecret(
    stableSecret(),
    "archestra-appa-proxy-wire-encryption-v1",
  );
}

function fingerprintKey() {
  return deriveKeyFromSecret(
    stableSecret(),
    "archestra-appa-proxy-wire-fingerprint-v1",
  );
}

function checkpointAad(
  scope: AppaProxyLedgerScope,
  checkpointId: string,
): string {
  return `checkpoint:${scope.sessionId}:${scope.ownerScopeHash}:${scope.profileId}:${checkpointId}`;
}

function parseCarrier(carrier: string): {
  callId: string;
  originalHash: string;
  signature: string;
} | null {
  const match = /^apc1\.([^.]+)\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(carrier);
  return match
    ? { callId: match[1], originalHash: match[2], signature: match[3] }
    : null;
}

function releasedArgumentsContainCarrier(
  emittedArgumentsCanonical: string,
  carrier: string,
  originalHash: string,
): boolean {
  try {
    const parsed = JSON.parse(emittedArgumentsCanonical) as unknown;
    if (!isRecord(parsed) || typeof parsed.prompt !== "string") return false;
    const prefix = `${carrier}\n`;
    if (!parsed.prompt.startsWith(prefix)) return false;
    const original = { ...parsed, prompt: parsed.prompt.slice(prefix.length) };
    return fingerprint(canonicalJson(original)) === originalHash;
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  const first = Buffer.from(left);
  const second = Buffer.from(right);
  return first.length === second.length && timingSafeEqual(first, second);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
