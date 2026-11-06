import { pipeline, type Readable, Transform } from "node:stream";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import type { FastifyHttpProxyOptions } from "@fastify/http-proxy";
import type { FastifyRequest } from "fastify";
import logger from "@/logging";
import { InteractionModel } from "@/models";
import type {
  GatewayAgent,
  InteractionAuthMethod,
  InteractionRequest,
  InteractionResponse,
} from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Pass-through requests (moderations, files, batches, token counts: whatever
 * has no governed route) are forwarded as they are, so no adapter reads their
 * usage. They are still logged: one row per call with the method and path,
 * the JSON bodies, the model and tokens when the provider names them, and a
 * cost only where OpenAI publishes one. Bodies are capped so a file upload or
 * a batch result cannot swell the log.
 */

/** Who a pass-through request was admitted as; its log row is attributed the same way. */
export interface PassthroughIdentity {
  agent: GatewayAgent;
  authMethod: InteractionAuthMethod;
  userId?: string;
  serviceAccountId?: string;
  virtualKeyId?: string;
  passthroughVirtualKeyId?: string;
  authenticatedApp?: { id: string; name: string };
  billingTeamId?: string;
}

interface PassthroughContext {
  provider: SupportedProvider;
  identity: PassthroughIdentity;
  startedAt: number;
  method: string;
  path: string;
  query?: string;
  contentType?: string;
  contentLength?: number;
  body?: unknown;
}

type ReplyOnResponse = NonNullable<
  NonNullable<FastifyHttpProxyOptions["replyOptions"]>["onResponse"]
>;

/** Bytes of a body kept for the log; a longer body is recorded by size only. */
const PASSTHROUGH_LOG_BODY_LIMIT = 256 * 1024;

const contexts = new WeakMap<object, PassthroughContext>();

/** Starts the log of a forwarded request, once its credential is resolved. */
export function beginPassthroughLog(
  request: FastifyRequest,
  params: {
    provider: SupportedProvider;
    identity: PassthroughIdentity | undefined;
    /** The upstream path and query, without the API prefix or agent id. */
    pathAndQuery: string;
  },
): void {
  if (!params.identity) return;
  const [path, ...rest] = params.pathAndQuery.split("?");
  const query = rest.join("?");
  const contentType = request.headers["content-type"];
  const contentLength = Number(request.headers["content-length"]);
  contexts.set(request, {
    provider: params.provider,
    identity: params.identity,
    startedAt: Date.now(),
    method: request.method,
    path,
    ...(query ? { query } : {}),
    ...(typeof contentType === "string"
      ? { contentType: contentType.split(";")[0].trim() }
      : {}),
    ...(Number.isFinite(contentLength) ? { contentLength } : {}),
  });
}

/** Keeps the parsed JSON body of a forwarded request for its log row. */
export function notePassthroughRequestBody(
  request: FastifyRequest,
  body: unknown,
): void {
  const context = contexts.get(request);
  if (context) context.body = body;
}

/**
 * `@fastify/reply-from` options for a catch-all proxy whose calls are logged.
 * The upstream body streams to the client as it arrives, through `next` when
 * the route has its own response hook; a bounded copy is kept for the log,
 * which is written once the stream ends.
 */
export function passthroughReplyOptions(next?: ReplyOnResponse): {
  onResponse: ReplyOnResponse;
} {
  const send: ReplyOnResponse =
    next ??
    ((_request, reply, response) => {
      reply.send(response.stream);
    });
  return {
    onResponse: (request, reply, response) => {
      const context = contexts.get(request);
      if (!context) {
        send(request, reply, response);
        return;
      }
      // The body is observed on its way to the client, never read beside it:
      // a `data` listener would start the upstream stream flowing before
      // Fastify pipes it (after its async onSend hooks), and every chunk in
      // that gap would reach the log and not the client.
      const chunks: Buffer[] = [];
      let bytes = 0;
      const observed = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes <= PASSTHROUGH_LOG_BODY_LIMIT) chunks.push(chunk);
          callback(null, chunk);
        },
      });
      const ended = new Promise<void>((resolve) => {
        pipeline(response.stream as Readable, observed, () => resolve());
      });
      const status = reply.statusCode;
      const contentType = reply.getHeader("content-type");
      const encoding = reply.getHeader("content-encoding");
      trackBackgroundWork(
        ended
          .then(() =>
            recordPassthroughInteraction({
              context,
              status,
              contentType:
                typeof contentType === "string"
                  ? contentType.split(";")[0].trim().toLowerCase()
                  : undefined,
              encoding: typeof encoding === "string" ? encoding : undefined,
              bytes,
              body:
                bytes <= PASSTHROUGH_LOG_BODY_LIMIT
                  ? Buffer.concat(chunks)
                  : undefined,
            }),
          )
          .catch((error) => {
            logger.warn(
              { error, provider: context.provider, path: context.path },
              "Could not log a pass-through request",
            );
          }),
      );
      // The same response, its `stream` swapped for the observed one. The
      // next handler only pipes `stream` onward (as the Anthropic token
      // count observer does), which a Transform satisfies.
      const forwarded: typeof response = Object.create(response, {
        stream: { value: observed, enumerable: true },
      });
      send(request, reply, forwarded);
    },
  };
}

async function recordPassthroughInteraction(params: {
  context: PassthroughContext;
  status: number;
  contentType?: string;
  encoding?: string;
  bytes: number;
  body: Buffer | undefined;
}): Promise<void> {
  const { context, status, contentType, bytes } = params;
  const { identity } = context;
  const streamed = contentType === "text/event-stream";
  const responseBody =
    params.body && contentType === "application/json"
      ? await parseJson(params.body, params.encoding)
      : undefined;
  const requestBody = boundedJson(context.body);
  const model = modelOf(context.body) ?? modelOf(responseBody) ?? undefined;
  const usage = usageOf(responseBody);
  const cost = passthroughCost({ path: context.path, model, status });
  const request = {
    method: context.method,
    path: context.path,
    ...(context.query ? { query: context.query } : {}),
    ...(context.contentType ? { content_type: context.contentType } : {}),
    ...(context.contentLength !== undefined
      ? { content_length: context.contentLength }
      : {}),
    ...(requestBody.body !== undefined ? { body: requestBody.body } : {}),
    ...(requestBody.truncated ? { truncated: true } : {}),
  };
  const response = {
    status,
    ...(contentType ? { content_type: contentType } : {}),
    bytes,
    ...(responseBody !== undefined ? { body: responseBody } : {}),
    ...(params.body === undefined && bytes > 0 ? { truncated: true } : {}),
    ...(streamed ? { streamed: true } : {}),
  };
  await InteractionModel.create({
    profileId: identity.agent.id,
    type: `${context.provider}:passthrough` as SupportedProviderDiscriminator,
    model,
    request: request as InteractionRequest,
    response: response as InteractionResponse,
    durationMs: Date.now() - context.startedAt,
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    cost,
    baselineCost: cost,
    authMethod: identity.authMethod,
    userId: identity.userId,
    serviceAccountId: identity.serviceAccountId,
    virtualKeyId: identity.virtualKeyId,
    passthroughVirtualKeyId: identity.passthroughVirtualKeyId,
    authenticatedAppId: identity.authenticatedApp?.id,
    authenticatedAppName: identity.authenticatedApp?.name,
    billingTeamId: identity.billingTeamId,
    billingMode: "metered",
    source: "api",
  });
}

/**
 * What a pass-through call cost. OpenAI bills nothing for moderations and
 * token counts, and nothing for a call it refused; every other pass-through
 * endpoint (files, batches, …) is billed in ways no response reports, so
 * its cost is recorded as unknown rather than zero.
 */
function passthroughCost(params: {
  path: string;
  model: string | undefined;
  status: number;
}): string | null {
  const free =
    params.status >= 400 ||
    /\/moderations$/.test(params.path) ||
    /(?:\/count_tokens|\/input_tokens)$/.test(params.path) ||
    /moderation/i.test(params.model ?? "");
  return free ? "0.0000000000" : null;
}

const decoders: Record<string, (body: Buffer) => Promise<Buffer>> = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
};

async function parseJson(
  body: Buffer,
  encoding: string | undefined,
): Promise<unknown> {
  try {
    const decoder = encoding ? decoders[encoding.trim().toLowerCase()] : null;
    const bytes = decoder ? await decoder(body) : body;
    if (bytes.length > PASSTHROUGH_LOG_BODY_LIMIT) return undefined;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** A request body as stored: the parsed JSON while it fits, else its size. */
function boundedJson(body: unknown): { body?: unknown; truncated?: boolean } {
  if (body === undefined) return {};
  const size = Buffer.byteLength(JSON.stringify(body) ?? "");
  return size <= PASSTHROUGH_LOG_BODY_LIMIT ? { body } : { truncated: true };
}

function modelOf(body: unknown): string | undefined {
  const model = (body as { model?: unknown } | undefined)?.model;
  return typeof model === "string" && model.length <= 512 ? model : undefined;
}

/**
 * Tokens a response reports: a `usage` object in the Chat Completions or
 * Responses shape, or the top-level counts of a token-count answer.
 */
function usageOf(
  body: unknown,
): { input: number | undefined; output: number | undefined } | undefined {
  const record = body as Record<string, unknown> | undefined;
  const usage =
    record?.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : typeof record?.input_tokens === "number"
        ? record
        : undefined;
  if (!usage) return undefined;
  const count = (...keys: string[]) => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return value;
    }
    return undefined;
  };
  const input = count("prompt_tokens", "input_tokens");
  const output = count("completion_tokens", "output_tokens");
  return input === undefined && output === undefined
    ? undefined
    : { input, output };
}
