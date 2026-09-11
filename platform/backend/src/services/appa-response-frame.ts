import { createHash } from "node:crypto";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import type { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import {
  AppaHistoryCodec,
  type AppaHistoryProtocol,
} from "./appa-history-codec";

const RESPONSE_FRAME_PROTOCOL = "appa-native-response-frame/v1";

export type AppaCompletedResponseFrame = {
  sourceFrameId: string;
  runtimeEventId: string;
  receiptHash: string;
  receiptIdentity: string;
  provider: string;
  protocol: AppaHistoryProtocol;
  model: string;
  bootstrapDigest: string | null;
  requestPrefix: unknown[];
  inheritedPrefix: unknown[];
  issuedItemsDigest: string;
  terminalOmission: boolean;
  compactionRequested: boolean;
  compactionProduced: boolean;
};

/**
 * Protocol-neutral sealed provider response. The encrypted wire frame owns the
 * exact request and response bytes; consumers receive only canonical history
 * facts and the completed receipt identity needed for checkpoint correlation.
 */
export class AppaResponseFrame {
  constructor(
    private readonly params: {
      session: AppaProxyHookSession;
      profileId: string;
    },
  ) {}

  async complete(params: {
    runtimeEventId: string;
    provider: string;
    protocol: AppaHistoryProtocol;
    model: string;
    request: unknown;
    response: unknown;
    expiresAt?: Date;
  }): Promise<AppaCompletedResponseFrame> {
    if (!isUuid(params.runtimeEventId)) {
      throw new Error("Native response frame requires a UUID runtime event ID");
    }
    if (!params.provider || !params.model) {
      throw new Error("Native response frame requires provider and model");
    }
    const scope = this.params.session.getNativeWireScope();
    await AppaProxyWireModel.assertOwnedProfile({
      ...scope,
      profileId: this.params.profileId,
    });
    const exchange = AppaHistoryCodec.exchange({
      protocol: params.protocol,
      request: params.request,
      response: params.response,
    });
    const requestHash = digest({
      provider: params.provider,
      protocol: params.protocol,
      model: params.model,
      request: exchange.rawRequest,
    });
    const responseHash = digest(exchange.response.rawResponse);
    const payload = {
      version: 1,
      provider: params.provider,
      protocol: params.protocol,
      model: params.model,
      request: exchange.rawRequest,
      response: exchange.response.rawResponse,
      requestPrefix: exchange.history,
      inheritedPrefix: exchange.inheritedHistory,
      bootstrapDigest: exchange.bootstrapDigest,
      issuedItemsDigest: exchange.response.issuedItemsDigest,
      terminalOmission: exchange.response.terminalOmission,
      compactionRequested: exchange.compactionRequested,
      compactionProduced: exchange.response.compactionProduced,
    };
    const frame = await AppaProxyWireModel.createFrame({
      ...scope,
      kind: "model_response",
      protocol: RESPONSE_FRAME_PROTOCOL,
      requestHash,
      idempotencyKey: `native-response-frame:${params.runtimeEventId}`,
      sourceResponseId:
        typeof exchange.response.rawResponse.id === "string"
          ? exchange.response.rawResponse.id
          : undefined,
      payload,
      expiresAt: params.expiresAt ?? new Date(Date.now() + 5 * 60_000),
    });
    const completed = await AppaProxyWireModel.completeModelResponseFrame({
      ...scope,
      frameId: frame.id,
      protocol: RESPONSE_FRAME_PROTOCOL,
      receipt: {
        version: 1,
        runtimeEventId: params.runtimeEventId,
        requestHash,
        responseHash,
        issuedItemsDigest: exchange.response.issuedItemsDigest,
      },
    });
    if (!completed.receiptHash) {
      throw new Error("Native response frame did not persist a receipt hash");
    }
    return {
      sourceFrameId: completed.id,
      runtimeEventId: params.runtimeEventId,
      receiptHash: completed.receiptHash,
      receiptIdentity: `${completed.id}:${completed.receiptHash}`,
      provider: params.provider,
      protocol: params.protocol,
      model: params.model,
      bootstrapDigest: exchange.bootstrapDigest,
      requestPrefix: exchange.history,
      inheritedPrefix: exchange.inheritedHistory,
      issuedItemsDigest: exchange.response.issuedItemsDigest,
      terminalOmission: exchange.response.terminalOmission,
      compactionRequested: exchange.compactionRequested,
      compactionProduced: exchange.response.compactionProduced,
    };
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, (item as Record<string, unknown>)[key]]),
      );
    }
    return item;
  });
  if (serialized === undefined) {
    throw new Error("Native response frame payload is not serializable");
  }
  return serialized;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
