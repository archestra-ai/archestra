import { createHash } from "node:crypto";
import { openappaNative } from "@/openappa/native";
import {
  type AppaCheckpoint,
  type AppaPreparedProxyEvent,
  type AppaProxyCapabilities,
  type AppaProxyEvent,
  type AppaProxyReceipt,
  AppaRuntimeError,
} from "./types";

/**
 * Native v1 proxy client. It has no HTTP or fallback transport: the embedded
 * OpenAPPA facade applies the durable receipt protocol in-process.
 */
export class AppaRuntimeClient {
  async capabilities(): Promise<AppaProxyCapabilities> {
    const module = await openappaNative();
    return parseCapabilities(await module.openappaProxyCapabilities());
  }

  prepareEvent(params: {
    eventId: string;
    event: AppaProxyEvent;
  }): AppaPreparedProxyEvent {
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
      throw new AppaRuntimeError(
        "invalid-response",
        "Invalid stored APPA event",
      );
    }
    if (
      sha256(params.body) !== params.requestSha256 ||
      !isEventEnvelope(envelope, params.eventId)
    ) {
      throw new AppaRuntimeError(
        "invalid-response",
        "Invalid stored APPA event",
      );
    }
    return {
      eventId: params.eventId,
      envelope,
      body: params.body,
      requestSha256: params.requestSha256,
    };
  }

  async postPreparedEvent(
    prepared: AppaPreparedProxyEvent,
    signal?: AbortSignal,
  ): Promise<AppaProxyReceipt> {
    if (signal?.aborted) throw unavailable("native event dispatch was aborted");
    const module = await openappaNative();
    if (signal?.aborted) throw unavailable("native event dispatch was aborted");
    return parseReceipt(
      await nativeResponse(module.dispatchOpenappaProxyEvent(prepared.body)),
      prepared,
    );
  }

  async checkpointCreate(rootId: string): Promise<AppaCheckpoint> {
    const module = await openappaNative();
    return parseCheckpoint(
      await nativeResponse(
        module.dispatchOpenappaCheckpoint(
          JSON.stringify({
            protocol: 1,
            adapter: "kagent",
            operation: "create",
            root_id: rootId,
          }),
        ),
      ),
    );
  }

  async checkpointFork(params: {
    checkpointId: string;
    rootId: string;
  }): Promise<void> {
    const module = await openappaNative();
    parseEmptyCheckpoint(
      await nativeResponse(
        module.dispatchOpenappaCheckpoint(
          JSON.stringify({
            protocol: 1,
            adapter: "kagent",
            operation: "fork",
            checkpoint_id: params.checkpointId,
            root_id: params.rootId,
          }),
        ),
      ),
      params.rootId,
    );
  }
}

function unavailable(message: string): AppaRuntimeError {
  return new AppaRuntimeError("unavailable", message);
}

function parseCapabilities(value: string): AppaProxyCapabilities {
  const parsed = parseJson(value);
  if (
    !isRecord(parsed) ||
    parsed.protocol_version !== 1 ||
    typeof parsed.legacy_hooks !== "boolean"
  ) {
    throw invalid("OpenAPPA returned invalid capabilities");
  }
  return parsed as AppaProxyCapabilities;
}

async function nativeResponse(operation: Promise<string>): Promise<unknown> {
  try {
    return parseJson(await operation);
  } catch (error) {
    if (error instanceof AppaRuntimeError) throw error;
    // Native errors can include database connection details or policy paths.
    // The proxy only exposes their stable category across this boundary.
    const uncertain =
      error instanceof Error && error.message.startsWith("event_uncertain:");
    throw new AppaRuntimeError(
      uncertain ? "uncertain" : "refused",
      uncertain
        ? "OpenAPPA could not confirm the native event outcome"
        : "OpenAPPA refused the native operation",
    );
  }
}

function parseReceipt(
  response: unknown,
  prepared: AppaPreparedProxyEvent,
): AppaProxyReceipt {
  if (
    !isRecord(response) ||
    response.protocol_version !== 1 ||
    response.event_id !== prepared.eventId ||
    response.request_sha256 !== prepared.requestSha256 ||
    !isRecord(response.decision)
  ) {
    throw invalid("OpenAPPA returned an invalid event receipt");
  }
  return response as AppaProxyReceipt;
}

function parseCheckpoint(response: unknown): AppaCheckpoint {
  if (
    !isRecord(response) ||
    typeof response.checkpoint_id !== "string" ||
    !isRecord(response.source_scope) ||
    typeof response.position !== "number" ||
    typeof response.digest !== "string"
  ) {
    throw invalid("OpenAPPA returned an invalid checkpoint");
  }
  return response as AppaCheckpoint;
}

function parseEmptyCheckpoint(response: unknown, rootId: string): void {
  if (!isRecord(response) || response.root_id !== rootId) {
    throw invalid("OpenAPPA refused the checkpoint fork");
  }
}

function isEventEnvelope(
  value: unknown,
  eventId: string,
): value is AppaPreparedProxyEvent["envelope"] {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { event_id?: unknown }).event_id === eventId &&
    !!(value as { event?: unknown }).event &&
    typeof (value as { event: unknown }).event === "object"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw invalid("OpenAPPA returned invalid JSON");
  }
}

function invalid(message: string): AppaRuntimeError {
  return new AppaRuntimeError("invalid-response", message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
