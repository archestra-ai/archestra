import { Readable } from "node:stream";
import zlib from "node:zlib";
import { type Dispatcher, request } from "undici";

/**
 * `fetch` for LLM upstream calls, sent with undici's request API.
 *
 * Provider SDKs only need a `fetch`-shaped function. The WHATWG `fetch` builds
 * a Request, validates and copies headers, and moves every body through web
 * streams; on a proxy that relays each request once, that costs more CPU than
 * the rest of the hop. This sends the same request with `undici.request` on
 * the same dispatcher, and keeps `fetch`'s observable behavior:
 *
 * - redirects, `Request` inputs, streamed or form bodies, configured
 *   environment proxies, and a `globalThis.fetch` replaced after startup (an
 *   instrumentation wrapper or a test's network mock) go through `fetch`;
 * - compressed responses are decoded, while headers are left as sent;
 * - text and JSON bodies are read before resolving; any other body (SSE,
 *   audio) streams;
 * - failures reject like `fetch`: aborts with the signal's reason, network
 *   errors as `TypeError("fetch failed")` with the cause attached.
 */
export async function llmUpstreamFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  dispatcher: Dispatcher | undefined,
): Promise<Response> {
  const viaFetch = () =>
    fetch(input, dispatcher ? ({ ...init, dispatcher } as RequestInit) : init);
  if (!sendsDirectly(input, init)) return viaFetch();

  let upstream: Dispatcher.ResponseData;
  try {
    upstream = await request(input as string | URL, {
      method: (init?.method ?? "GET") as Dispatcher.HttpMethod,
      headers: headerRecord(init?.headers),
      body: init?.body as string | Uint8Array | null | undefined,
      signal: init?.signal ?? undefined,
      dispatcher,
    });
  } catch (error) {
    throw asFetchError(error, init?.signal);
  }

  const { statusCode: status, body } = upstream;
  if (REDIRECT_STATUSES.has(status) && upstream.headers.location) {
    body.resume();
    return viaFetch();
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const options = { status, statusText: upstream.statusText, headers };
  if (NULL_BODY_STATUSES.has(status)) {
    body.resume();
    return new Response(null, options);
  }

  const decoded = decode(body, headers.get("content-encoding"));
  if (!readsWhole(headers.get("content-type"))) {
    return new Response(Readable.toWeb(decoded) as ReadableStream, options);
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of decoded) chunks.push(chunk as Buffer);
    return new Response(Buffer.concat(chunks), options);
  } catch (error) {
    throw asFetchError(error, init?.signal);
  }
}

// ===========================================================================
// Internal
// ===========================================================================

const startupFetch = globalThis.fetch;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const PROXY_ENVIRONMENT = [
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

function sendsDirectly(
  input: string | URL | Request,
  init: RequestInit | undefined,
): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  if (!/^https?:/i.test(String(input))) return false;
  if (init?.redirect && init.redirect !== "follow") return false;
  const body = init?.body;
  if (body != null && typeof body !== "string" && !(body instanceof Uint8Array))
    return false;
  if (globalThis.fetch !== startupFetch) return false;
  return !PROXY_ENVIRONMENT.some((name) => process.env[name]);
}

function headerRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers || Array.isArray(headers)) {
    for (const [name, value] of new Headers(headers)) record[name] = value;
    return record;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) record[name.toLowerCase()] = String(value);
  }
  return record;
}

function readsWhole(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  if (type.includes("event-stream") || type.includes("ndjson")) return false;
  return type.includes("json") || type.startsWith("text/");
}

function decode(body: Readable, encoding: string | null): Readable {
  let decoded = body;
  // Codings are listed in the order they were applied; undo them in reverse.
  const codings = (encoding ?? "")
    .toLowerCase()
    .split(",")
    .map((coding) => coding.trim())
    .filter((coding) => coding && coding !== "identity")
    .reverse();
  for (const coding of codings) {
    const decoder =
      coding === "gzip" || coding === "x-gzip"
        ? zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH })
        : coding === "deflate"
          ? zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH })
          : coding === "br"
            ? zlib.createBrotliDecompress({
                flush: zlib.constants.BROTLI_OPERATION_FLUSH,
              })
            : null;
    // An unknown coding is passed through, as fetch does.
    if (!decoder) return decoded;
    decoded.on("error", (error) => decoder.destroy(error));
    decoded = decoded.pipe(decoder);
  }
  return decoded;
}

function asFetchError(error: unknown, signal: AbortSignal | null | undefined) {
  if (signal?.aborted) return signal.reason;
  if (error instanceof Error && error.name === "AbortError") return error;
  return new TypeError("fetch failed", { cause: error });
}
