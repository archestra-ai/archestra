/** Runtime events are opaque to the host and validated by the native core. */
export type AppaProxyEvent = Record<string, unknown> & { event: string };

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

export type AppaPreparedProxyEvent = {
  eventId: string;
  envelope: { event_id: string; event: AppaProxyEvent };
  body: string;
  requestSha256: string;
};

export class AppaRuntimeError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid-response" | "uncertain" | "refused",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AppaRuntimeError";
  }
}
