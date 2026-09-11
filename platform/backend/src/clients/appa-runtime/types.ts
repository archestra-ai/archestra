/** Runtime OpenAPI declares the envelope event as unconstrained JSON. */
export type AppaProxyEvent = Record<string, unknown> & { event: string };

/** Runtime capability and receipt response schemas are validated at the boundary. */
export type AppaProxyCapabilities = Record<string, unknown> & {
  protocol_version: number;
  legacy_hooks: boolean;
};

export type AppaProxyReceipt = {
  protocol_version: number;
  event_id: string;
  request_sha256: string;
  decision: Record<string, unknown>;
};

export type AppaCheckpoint = {
  checkpoint_id: string;
  source_scope: Record<string, unknown>;
  position: number;
  digest: string;
};

export type AppaRuntimeClientOptions = {
  /** Matches the validated AppaProxyHookConfig.url. */
  url: string;
  /** Matches AppaProxyHookConfig.runtimeToken and is required for v1. */
  runtimeToken: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type AppaPreparedProxyEvent = {
  eventId: string;
  envelope: { event_id: string; event: AppaProxyEvent };
  body: string;
  requestSha256: string;
};

type AppaTransportErrorCode =
  | "invalid-endpoint"
  | "timeout"
  | "transport"
  | "uncertain"
  | "refused"
  | "invalid-response";

export class AppaRuntimeError extends Error {
  constructor(
    readonly code: AppaTransportErrorCode,
    message: string,
    readonly status?: number,
    readonly runtimeCode?: string,
  ) {
    super(message);
    this.name = "AppaRuntimeError";
  }
}
