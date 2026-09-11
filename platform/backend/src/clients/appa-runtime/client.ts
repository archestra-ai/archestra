import { createHash } from "node:crypto";
import { AppaRuntimeTransport } from "./transport";
import {
  type AppaCheckpoint,
  type AppaPreparedProxyEvent,
  type AppaProxyCapabilities,
  type AppaProxyEvent,
  type AppaProxyReceipt,
  type AppaRuntimeClientOptions,
  AppaRuntimeError,
} from "./types";

/**
 * Typed HTTP boundary for the authenticated durable proxy protocol.
 * Callers own event IDs, persisted request bytes, retries, and quarantine.
 */
export class AppaRuntimeClient {
  private readonly transport: AppaRuntimeTransport;

  constructor(options: AppaRuntimeClientOptions) {
    this.transport = new AppaRuntimeTransport(options);
  }

  async capabilities(): Promise<AppaProxyCapabilities> {
    const value = record(await this.transport.capabilities(), "capabilities");
    if (value.protocol_version !== 1 || value.legacy_hooks !== false) {
      throw invalid("capabilities");
    }
    return value as AppaProxyCapabilities;
  }

  prepareEvent(params: {
    eventId: string;
    event: AppaProxyEvent;
  }): AppaPreparedProxyEvent {
    if (!uuid(params.eventId)) {
      throw new AppaRuntimeError(
        "invalid-response",
        "OpenAPPA eventId must be a UUID",
      );
    }
    const envelope = { event_id: params.eventId, event: params.event };
    const body = JSON.stringify(envelope);
    return {
      eventId: params.eventId,
      envelope,
      body,
      requestSha256: sha256(body),
    };
  }

  restorePreparedEvent(params: {
    eventId: string;
    body: string;
    requestSha256: string;
  }): AppaPreparedProxyEvent {
    let envelope: unknown;
    try {
      envelope = JSON.parse(params.body);
    } catch {
      throw invalid("stored event");
    }
    if (
      !uuid(params.eventId) ||
      sha256(params.body) !== params.requestSha256 ||
      !isRecord(envelope) ||
      envelope.event_id !== params.eventId ||
      !isRecord(envelope.event) ||
      typeof envelope.event.event !== "string"
    ) {
      throw invalid("stored event");
    }
    return {
      eventId: params.eventId,
      envelope: envelope as AppaPreparedProxyEvent["envelope"],
      body: params.body,
      requestSha256: params.requestSha256,
    };
  }

  async postPreparedEvent(
    prepared: AppaPreparedProxyEvent,
    signal?: AbortSignal,
  ): Promise<AppaProxyReceipt> {
    if (
      !uuid(prepared.eventId) ||
      sha256(prepared.body) !== prepared.requestSha256 ||
      prepared.envelope.event_id !== prepared.eventId
    ) {
      throw invalid("prepared event");
    }
    const value = record(
      await this.transport.event(prepared.envelope, prepared.body, signal),
      "event receipt",
    );
    if (
      value.protocol_version !== 1 ||
      value.event_id !== prepared.eventId ||
      value.request_sha256 !== prepared.requestSha256 ||
      !isRecord(value.decision)
    ) {
      throw invalid("event receipt");
    }
    return value as AppaProxyReceipt;
  }

  async checkpointCreate(rootId: string): Promise<AppaCheckpoint> {
    const value = record(
      await this.transport.checkpoint({
        protocol: 1,
        adapter: "kagent",
        operation: "create",
        root_id: required(rootId, "rootId"),
      }),
      "checkpoint",
    );
    if (
      typeof value.checkpoint_id !== "string" ||
      !isRecord(value.source_scope) ||
      value.source_scope.root_id !== rootId ||
      typeof value.position !== "number" ||
      typeof value.digest !== "string"
    ) {
      throw invalid("checkpoint");
    }
    return value as AppaCheckpoint;
  }

  async checkpointFork(params: {
    checkpointId: string;
    rootId: string;
  }): Promise<void> {
    const rootId = required(params.rootId, "rootId");
    const value = record(
      await this.transport.checkpoint({
        protocol: 1,
        adapter: "kagent",
        operation: "fork",
        checkpoint_id: required(params.checkpointId, "checkpointId"),
        root_id: rootId,
      }),
      "checkpoint fork",
    );
    if (value.root_id !== rootId) throw invalid("checkpoint fork");
  }
}

function invalid(operation: string): AppaRuntimeError {
  return new AppaRuntimeError(
    "invalid-response",
    `OpenAPPA proxy returned an invalid ${operation} response`,
  );
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(operation);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(value: string, name: string): string {
  if (!value || /[\r\n]/.test(value)) {
    throw new AppaRuntimeError(
      "invalid-response",
      `OpenAPPA ${name} must be non-empty`,
    );
  }
  return value;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
