import { createHash } from "node:crypto";
import { context as otelContext, ROOT_CONTEXT } from "@opentelemetry/api";
import logger from "@/logging";

type AppaProxyPhase =
  | "authorization_receipt"
  | "proposal_socket_write_finish"
  | "result_admission_receipt"
  | "continuation_socket_write_finish";

type RuntimeReceipt = {
  id: string;
  sha256: string;
};

/**
 * Append-only, backend-owned correlation evidence for native APPA turns.
 * Socket phases mean only that Node completed the local response write; they
 * never imply client execution or acknowledgement.
 */
export class AppaProxyPhaseTrace {
  constructor(
    private readonly context: {
      traceId?: string;
      ownerScopeHash: string;
      provider: string;
      protocol: string;
      sessionId: string;
    },
  ) {}

  authorizationReceipt(params: {
    callIds: readonly string[];
    receipt: RuntimeReceipt;
  }): void {
    this.recordMany({
      phase: "authorization_receipt",
      callIds: params.callIds,
      receipt: params.receipt,
    });
  }

  resultAdmissionReceipt(params: {
    callId: string;
    receipt: RuntimeReceipt;
  }): void {
    this.recordMany({
      phase: "result_admission_receipt",
      callIds: [params.callId],
      receipt: params.receipt,
    });
  }

  proposalSocketWriteFinish(callIds: readonly string[]): void {
    this.recordMany({
      phase: "proposal_socket_write_finish",
      callIds,
    });
  }

  continuationSocketWriteFinish(callIds: readonly string[]): void {
    this.recordMany({
      phase: "continuation_socket_write_finish",
      callIds,
    });
  }

  failure(params: {
    phase: "acquire" | "native_setup" | "native_process_history" | "turn_close";
    error: unknown;
  }): void {
    const error = params.error instanceof Error ? params.error : undefined;
    // Keep only source locations from this integration, never error text,
    // absolute paths, caller-supplied fields, or the surrounding trace context.
    const prefix = error ? `${error.name}: ${error.message}` : "";
    const frames = error?.stack?.startsWith(prefix)
      ? error.stack.slice(prefix.length)
      : "";
    const locations = frames
      .split("\n")
      .filter((line) => /^\s+at\s/.test(line))
      .flatMap(
        (line) =>
          line.match(
            /src\/(?:routes\/proxy|services|models)\/(?:appa-[a-z-]+|llm-proxy-handler)\.ts:\d+:\d+/g,
          ) ?? [],
      );
    otelContext.with(ROOT_CONTEXT, () => {
      logger.warn(
        {
          event: "appa_proxy_failure",
          phase: params.phase,
          occurred_at: new Date().toISOString(),
          session_id_sha256: sha256(this.context.sessionId),
          trace_id_sha256: sha256(this.context.traceId ?? "unavailable"),
          error_sha256: sha256(error?.message ?? typeof params.error),
          source_locations: [...new Set(locations ?? [])].slice(0, 6),
        },
        "APPA proxy failure",
      );
      logger.flush();
    });
  }

  private recordMany(params: {
    phase: AppaProxyPhase;
    callIds: readonly string[];
    receipt?: RuntimeReceipt;
  }): void {
    for (const callId of params.callIds) {
      // The logger normally injects raw trace/session fields. This record uses
      // only its explicit hashed join values, so emit outside that context.
      otelContext.with(ROOT_CONTEXT, () => {
        logger.info(
          {
            event: "appa_proxy_phase_trace",
            phase: params.phase,
            occurred_at: new Date().toISOString(),
            call_id_sha256: sha256(callId),
            trace_id_sha256: sha256(this.context.traceId ?? "unavailable"),
            bound_auth_scope_hash: this.context.ownerScopeHash,
            provider: this.context.provider,
            protocol: this.context.protocol,
            session_id_sha256: sha256(this.context.sessionId),
            backend_instance_id: process.env.HOSTNAME ?? "unknown",
            delivery_semantics:
              "local_write_completion_not_client_execution_or_ack",
            ...(params.receipt
              ? {
                  runtime_receipt_id: params.receipt.id,
                  runtime_receipt_sha256: params.receipt.sha256,
                }
              : {}),
          },
          "APPA proxy phase trace",
        );
        // The private evidence reader runs immediately after the fixture exits.
        // Flush this native-only record instead of waiting for stdout batching.
        logger.flush();
      });
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
