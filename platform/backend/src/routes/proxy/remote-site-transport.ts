/**
 * Relaying one upstream provider call to the site that serves its key.
 *
 * A provider key can name the site that calls the provider with it (see
 * `sites/README.md`): a keyless Vertex AI key works only where the workload
 * identity lives. The site that received the client's request still runs the
 * whole proxy pipeline (auth, limits, guardrails, pool selection, logging,
 * spend) exactly once; only the upstream call travels. The serving site
 * builds the provider client with its own credentials, makes the call and
 * answers with the provider's response or chunks, untouched by any pipeline,
 * so nothing is recorded twice.
 *
 * Both halves live here so the wire format stays in one place:
 * `remoteSiteTransport` (the receiving site's `MemberTransport`) and
 * `serveRelayedCall` (what the serving site's channel route runs).
 */
import type { InteractionSource, SupportedProvider } from "@archestra/shared";
import logger from "@/logging";
import { LlmProviderApiKeyModel } from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { postToSite, readSseJson } from "@/sites/channel-client";
import { currentSiteName, isServedHere } from "@/sites/registry";
import type { UsageView } from "@/types";
import { asRecord } from "@/utils/as-record";
import {
  inboundPoolWire,
  type MemberTransport,
  memberAdapter,
  memberTransport,
  type PoolWire,
} from "./model-pool-transport";

/** The channel path the LLM relay is served on. */
export const LLM_RELAY_PATH = "/llm/call";

/** One upstream call, as the receiving site sends it to the serving site. */
export interface RelayedLlmCall {
  providerApiKeyId: string;
  provider: SupportedProvider;
  inbound: PoolWire;
  modelId: string;
  /**
   * `member`: sent like a model pool member (its model id, and a translator
   * when the provider speaks another wire). `own`: the request already is the
   * provider's, sent as is, like a request without a pool.
   */
  mode: "member" | "own";
  /** The client route's reasoning-token dialect; see `memberTransport`. */
  inboundReasoningOutsideCompletion?: boolean;
  /** Protocol headers (anthropic-beta, ...) for a member on the client's wire. */
  headers: Record<string, string>;
  googleUserProject?: string;
  sessionId?: string;
  source: InteractionSource;
  stream: boolean;
  request: unknown;
}

/** One `data:` event of a relayed stream. */
type RelayStreamEvent =
  | { chunk: unknown }
  | { usage: UsageView | null }
  | { error: SerializedError };

/** A provider error, carried across the channel with what failover reads. */
interface SerializedError {
  message: string;
  name?: string;
  status?: number;
  code?: unknown;
  error?: unknown;
  retryAfter?: string;
}

/** An error from the serving site: the provider's, or the site's refusal. */
export class RelayedUpstreamError extends Error {
  readonly status?: number;
  readonly code?: unknown;
  readonly error?: unknown;
  readonly headers?: Record<string, string>;
  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = serialized.name ?? "RelayedUpstreamError";
    this.status = serialized.status;
    this.code = serialized.code;
    this.error = serialized.error;
    if (serialized.retryAfter)
      this.headers = { "retry-after": serialized.retryAfter };
  }
}

/**
 * The `MemberTransport` that sends the call to `siteName` instead of the
 * provider. `keyName` names the key in errors when the site is unreachable.
 */
export function remoteSiteTransport(params: {
  siteName: string;
  keyName: string;
  call: Omit<RelayedLlmCall, "stream" | "request">;
  signal?: AbortSignal;
}): MemberTransport {
  const { siteName, keyName, call, signal } = params;
  let usage: UsageView | null = null;
  const post = (stream: boolean, request: unknown) =>
    postToSite({
      siteName,
      path: LLM_RELAY_PATH,
      body: { ...call, stream, request } satisfies RelayedLlmCall,
      what: `Provider key "${keyName}"`,
      signal,
    });
  return {
    getUsage: () => usage,
    getStreamUsage: () => usage,
    async execute(request) {
      const response = await post(false, request);
      const body = asRecord(await response.json());
      if (!response.ok) throw relayFailure(siteName, response.status, body);
      usage = (body?.usage as UsageView | null | undefined) ?? null;
      return body?.response;
    },
    async executeStream(request, onAccepted) {
      const response = await post(true, request);
      if (!response.ok || !response.body)
        throw relayFailure(
          siteName,
          response.status,
          asRecord(await response.json().catch(() => null)),
        );
      // The serving site answers only once its provider accepted the call.
      onAccepted?.();
      const events = readSseJson(response.body);
      return (async function* () {
        for await (const event of events as AsyncIterable<RelayStreamEvent>) {
          if ("chunk" in event) yield event.chunk;
          else if ("usage" in event) usage = event.usage;
          else if ("error" in event)
            throw new RelayedUpstreamError(event.error);
        }
      })();
    },
  };
}

/**
 * Whether a request without a pool can be relayed as is: its route's adapter
 * must be the one a pool member on its provider would use, so the serving
 * site rebuilds the same client.
 */
export function relayWireForOwnRequest(
  provider: SupportedProvider,
  interactionType: string,
): PoolWire | null {
  const wire = inboundPoolWire(
    interactionType as Parameters<typeof inboundPoolWire>[0],
  );
  if (!wire) return null;
  return memberAdapter(provider, wire)?.interactionType === interactionType
    ? wire
    : null;
}

/** The serving site's side: refused before the provider was ever called. */
export class RelayRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayRefusedError";
  }
}

/**
 * Make a relayed call with this site's own credentials. `open` resolves once
 * the provider accepted the call: with the whole response, or with a stream
 * of chunks, and the usage the translation observed.
 */
export async function serveRelayedCall(
  call: RelayedLlmCall,
  signal: AbortSignal,
): Promise<
  | { stream: false; response: unknown; usage: UsageView | null }
  | {
      stream: true;
      chunks: AsyncIterable<unknown>;
      usage: () => UsageView | null;
    }
> {
  const row = await LlmProviderApiKeyModel.findById(call.providerApiKeyId);
  if (!row)
    throw new RelayRefusedError(404, "The provider key no longer exists");
  if (row.provider !== call.provider)
    throw new RelayRefusedError(
      400,
      "The provider key is for another provider",
    );
  if (!isServedHere(row.siteName))
    throw new RelayRefusedError(
      409,
      `Provider key "${row.name}" is served by site "${row.siteName}", not "${currentSiteName()}"`,
    );
  const adapter = memberAdapter(call.provider, call.inbound);
  if (!adapter)
    throw new RelayRefusedError(
      400,
      `Provider ${call.provider} cannot be relayed on ${call.inbound}`,
    );
  const apiKey = row.secretId
    ? await getSecretValueForLlmProviderApiKey(row.secretId)
    : undefined;
  const client = adapter.createClient(apiKey, {
    baseUrl: row.inferenceBaseUrl ?? row.baseUrl ?? adapter.getBaseUrl(),
    abortSignal: signal,
    source: call.source,
    model: call.modelId,
    defaultHeaders: { ...(row.extraHeaders ?? {}), ...call.headers },
    llmProviderApiKeyId: row.id,
    sessionId: call.sessionId,
    googleUserProject: call.googleUserProject,
  });
  const transport: MemberTransport =
    call.mode === "member"
      ? memberTransport({
          inbound: call.inbound,
          provider: call.provider,
          modelId: call.modelId,
          client,
          inboundReasoningOutsideCompletion:
            call.inboundReasoningOutsideCompletion,
        })
      : {
          execute: (request) => adapter.execute(client, request),
          executeStream: (request, onAccepted) =>
            adapter.executeStream(client, request, onAccepted),
        };
  logger.debug(
    {
      providerApiKeyId: row.id,
      provider: call.provider,
      model: call.modelId,
      stream: call.stream,
    },
    "Serving a relayed upstream call",
  );
  if (!call.stream) {
    const response = await transport.execute(call.request);
    return { stream: false, response, usage: transport.getUsage?.() ?? null };
  }
  const chunks = await transport.executeStream(call.request);
  return {
    stream: true,
    chunks,
    usage: () => transport.getStreamUsage?.() ?? transport.getUsage?.() ?? null,
  };
}

/** What failover and error reporting read off an error, as JSON. */
export function serializeRelayError(error: unknown): SerializedError {
  const record = asRecord(error);
  const status =
    typeof record?.status === "number"
      ? record.status
      : typeof record?.statusCode === "number"
        ? record.statusCode
        : typeof asRecord(record?.$metadata)?.httpStatusCode === "number"
          ? (asRecord(record?.$metadata)?.httpStatusCode as number)
          : undefined;
  const headers = record?.headers;
  const retryAfter =
    headers instanceof Headers
      ? (headers.get("retry-after") ?? undefined)
      : (asRecord(headers)?.["retry-after"] as string | undefined);
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : undefined,
    status,
    code: record?.code,
    error: record?.error,
    retryAfter: typeof retryAfter === "string" ? retryAfter : undefined,
  };
}

/** One SSE frame of a relayed stream. */
export function relayStreamFrame(event: RelayStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// === Internal helpers ===

function relayFailure(
  siteName: string,
  httpStatus: number,
  body: Record<string, unknown> | undefined,
): Error {
  const serialized = asRecord(body?.error) as SerializedError | undefined;
  if (body?.origin === "upstream" && serialized)
    return new RelayedUpstreamError(serialized);
  // The site itself refused: a misconfiguration to fix, not a provider
  // failure. Still a 502 so a pool can move on.
  return new RelayedUpstreamError({
    message: `Site "${siteName}" refused the relayed call (HTTP ${httpStatus}): ${
      serialized?.message ?? "no reason given"
    }`,
    status: 502,
  });
}
