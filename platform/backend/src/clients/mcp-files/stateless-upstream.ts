import { randomUUID } from "node:crypto";
import { MCP_FILES_EXTENSION_ID } from "@archestra/shared";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_CLIENT_INFO_META_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_PROTOCOL_VERSION_META_KEY,
  SERVER_DISCOVER_METHOD,
  STATELESS_MCP_PROTOCOL_REVISION,
} from "@/routes/mcp-gateway/protocol";
import { buildMcpClientInfo } from "@/utils/mcp-client-info";
import { isObject } from "./is-object";

/**
 * Requests to an upstream MCP server in protocol revision 2026-07-28.
 *
 * The gateway's pooled upstream connections speak 2025-11-25 through the SDK,
 * which predates this revision. The File Uploads extension exists only from
 * 2026-07-28 on — a server treats an older request as declaring neither
 * direction — so file-bearing requests go out here instead. The revision is
 * stateless, so each request is one HTTP POST: no handshake, no session.
 */

/** Where and how to reach an upstream server's MCP endpoint. */
export type UpstreamHttpTarget = {
  /** The MCP address. */
  url: URL;
  /** Every header the gateway sends on its MCP requests to this server. */
  headers: Record<string, string>;
  /**
   * Only the credential among {@link headers}: what an `include` upload
   * target may receive. Empty when the server takes no header credential.
   */
  credentialHeaders: Record<string, string>;
  /** The fetch MCP requests use (it may sign them). */
  fetch: FetchLike;
  /**
   * Whether requests are signed by {@link fetch} rather than carried in a
   * header. An `include` target cannot be honoured then: the signature covers
   * the MCP request, not an upload.
   */
  signsRequests: boolean;
};

/**
 * What the gateway declares upstream when it lists tools for itself: it
 * relays uploads, so it can take every tool a server offers with files.
 * Downloads are not relayed and so never declared.
 */
export const GATEWAY_UPSTREAM_FILES_CAPABILITIES = {
  extensions: { [MCP_FILES_EXTENSION_ID]: { upload: {} } },
};

/** What a server says about the files extension in `server/discover`. */
export type UpstreamFilesSupport = {
  upload: boolean;
  /** Largest total inline `data` the server accepts in one call; 0 = none. */
  maxInlineBytes: number;
};

export type JsonRpcOutcome =
  | { kind: "result"; result: Record<string, unknown> }
  | {
      kind: "error";
      error: { code: number; message: string; data?: unknown };
    };

export class StatelessUpstreamError extends Error {
  constructor(
    message: string,
    /** The HTTP status, when the server answered without JSON-RPC. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "StatelessUpstreamError";
  }
}

/** Whether an abort reason is a deadline passing rather than a cancel. */
export function isTimeout(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

/**
 * Send one 2026-07-28 request and return its JSON-RPC outcome.
 *
 * Throws {@link StatelessUpstreamError} when no JSON-RPC response arrives (a
 * transport failure, a deadline passing, a non-JSON body, a stream that ends
 * without the answer): for a `tools/call` that means the outcome is unknown.
 * A cancelled `signal` propagates as the abort it is.
 */
export async function sendStatelessRequest(params: {
  target: UpstreamHttpTarget;
  method: string;
  requestParams: Record<string, unknown>;
  /** The `Mcp-Name` routing header, for methods addressing a named target. */
  name?: string;
  clientCapabilities: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<JsonRpcOutcome> {
  const { target, method, name, signal } = params;
  const id = randomUUID();
  const existingMeta = params.requestParams._meta;
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params.requestParams,
      _meta: {
        ...(isObject(existingMeta) ? existingMeta : {}),
        [MCP_PROTOCOL_VERSION_META_KEY]: STATELESS_MCP_PROTOCOL_REVISION,
        [MCP_CLIENT_INFO_META_KEY]: buildMcpClientInfo("archestra-platform"),
        [MCP_CLIENT_CAPABILITIES_META_KEY]: params.clientCapabilities,
      },
    },
  };

  let response: Response;
  try {
    response = await target.fetch(target.url, {
      method: "POST",
      headers: {
        ...target.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [MCP_PROTOCOL_VERSION_HEADER]: STATELESS_MCP_PROTOCOL_REVISION,
        [MCP_METHOD_HEADER]: method,
        ...(name !== undefined && { [MCP_NAME_HEADER]: name }),
      },
      body: JSON.stringify(message),
      signal,
      redirect: "manual",
    });
  } catch (error) {
    throw transportFailure(error, signal, "could not be reached");
  }

  const mediaType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (mediaType === "text/event-stream" && response.ok && response.body) {
    try {
      return await readEventStreamAnswer(response.body, id);
    } catch (error) {
      if (error instanceof StatelessUpstreamError) throw error;
      throw transportFailure(error, signal, "stopped answering");
    }
  }

  // 2026-07-28 answers errors with a 4xx carrying the JSON-RPC error, so a
  // non-2xx JSON body is still read as an answer.
  if (mediaType === "application/json") {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new StatelessUpstreamError(
        `The MCP server answered HTTP ${response.status} with invalid JSON.`,
        response.status,
      );
    }
    const outcome = toOutcome(body);
    if (outcome) return outcome;
  } else {
    await response.body?.cancel();
  }
  throw new StatelessUpstreamError(
    `The MCP server answered HTTP ${response.status} without a JSON-RPC response.`,
    response.status,
  );
}

/**
 * What the server supports of the files extension, from `server/discover`.
 *
 * Remembered per install for a few minutes: the answer is the same for every
 * caller, and a file call should not pay for discovery each time. A server that
 * does not answer `server/discover` supports nothing.
 */
export async function discoverUpstreamFilesSupport(params: {
  target: UpstreamHttpTarget;
  cacheKey: string;
  signal: AbortSignal;
}): Promise<UpstreamFilesSupport> {
  const cached = filesSupportCache.get(params.cacheKey);
  if (cached) return cached;

  let outcome: JsonRpcOutcome;
  try {
    outcome = await sendStatelessRequest({
      target: params.target,
      method: SERVER_DISCOVER_METHOD,
      requestParams: {},
      clientCapabilities: {},
      signal: params.signal,
    });
  } catch (error) {
    if (!(error instanceof StatelessUpstreamError)) throw error;
    // No JSON-RPC answer at all: a server that predates the revision, or one
    // that is down. Not remembered, so a server that recovers is seen at once.
    logger.info(
      { cacheKey: params.cacheKey, error: error.message },
      "MCP server gave no server/discover answer; treating it as without file support",
    );
    return NO_FILES_SUPPORT;
  }
  // An error answer (method not found, say) is as definite as a result.
  const support =
    outcome.kind === "result"
      ? parseFilesSupport(outcome.result)
      : NO_FILES_SUPPORT;
  filesSupportCache.set(params.cacheKey, support);
  return support;
}

/**
 * Read the files extension settings out of a `server/discover` result.
 *
 * @internal exported for tests
 */
export function parseFilesSupport(
  result: Record<string, unknown>,
): UpstreamFilesSupport {
  const versions = result.supportedVersions ?? result.protocolVersions;
  if (
    Array.isArray(versions) &&
    !versions.includes(STATELESS_MCP_PROTOCOL_REVISION)
  ) {
    return NO_FILES_SUPPORT;
  }
  const capabilities = result.capabilities;
  if (!isObject(capabilities) || !isObject(capabilities.extensions)) {
    return NO_FILES_SUPPORT;
  }
  const settings = capabilities.extensions[MCP_FILES_EXTENSION_ID];
  // A revision the gateway does not know means the extension is not declared.
  if (!isObject(settings) || settings.revision !== undefined) {
    return NO_FILES_SUPPORT;
  }
  const { maxInlineBytes } = settings;
  return {
    upload: isObject(settings.upload),
    maxInlineBytes:
      typeof maxInlineBytes === "number" &&
      Number.isSafeInteger(maxInlineBytes) &&
      maxInlineBytes > 0
        ? maxInlineBytes
        : 0,
  };
}

// === Internal helpers ===

const NO_FILES_SUPPORT: UpstreamFilesSupport = Object.freeze({
  upload: false,
  maxInlineBytes: 0,
});

const FILES_SUPPORT_TTL_MS = 5 * 60 * 1000;

const filesSupportCache = registerProcessLocalCache(
  new LRUCacheManager<UpstreamFilesSupport>({
    maxSize: 1000,
    defaultTtl: FILES_SUPPORT_TTL_MS,
  }),
);

/** Read SSE events until the response to `id` arrives. */
async function readEventStreamAnswer(
  body: ReadableStream<Uint8Array>,
  id: string,
): Promise<JsonRpcOutcome> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalized over the whole buffer: a CRLF can straddle two reads.
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll(
        "\r\n",
        "\n",
      );
      for (
        let end = buffer.indexOf("\n\n");
        end !== -1;
        end = buffer.indexOf("\n\n")
      ) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          continue;
        }
        if (isObject(message) && message.id === id) {
          const outcome = toOutcome(message);
          if (outcome) return outcome;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new StatelessUpstreamError(
    "The MCP server's event stream ended without answering the request.",
  );
}

function toOutcome(message: unknown): JsonRpcOutcome | undefined {
  if (!isObject(message)) return undefined;
  if (isObject(message.result)) {
    return { kind: "result", result: message.result };
  }
  const error = message.error;
  if (
    isObject(error) &&
    typeof error.code === "number" &&
    typeof error.message === "string"
  ) {
    return {
      kind: "error",
      error: {
        code: error.code,
        message: error.message,
        ...(error.data !== undefined && { data: error.data }),
      },
    };
  }
  return undefined;
}

/** Most pages of tools one listing follows before giving up. */
const MAX_TOOL_LIST_PAGES = 50;

/**
 * Every tool the server lists to a 2026-07-28 request declaring the given
 * capabilities, following `nextCursor` across pages.
 *
 * A conforming server lists a tool with an `x-mcp-file` argument only to a
 * request that declared the files extension, so this listing can hold tools
 * the pooled 2025-11-25 listing never shows.
 */
export async function listStatelessTools(params: {
  target: UpstreamHttpTarget;
  clientCapabilities: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<Record<string, unknown>[]> {
  const tools: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const outcome = await sendStatelessRequest({
      target: params.target,
      method: "tools/list",
      requestParams: cursor === undefined ? {} : { cursor },
      clientCapabilities: params.clientCapabilities,
      signal: params.signal,
    });
    if (outcome.kind === "error") {
      throw new StatelessUpstreamError(
        `The MCP server refused tools/list: ${outcome.error.message}`,
      );
    }
    const pageTools = outcome.result.tools;
    if (!Array.isArray(pageTools)) {
      throw new StatelessUpstreamError(
        "The MCP server answered tools/list without a tools array.",
      );
    }
    tools.push(...pageTools.filter(isObject));
    const next = outcome.result.nextCursor;
    if (typeof next !== "string" || next.length === 0) return tools;
    cursor = next;
  }
  throw new StatelessUpstreamError(
    `The MCP server's tool list ran past ${MAX_TOOL_LIST_PAGES} pages.`,
  );
}

/**
 * A request that got no answer: a deadline passing is the server's failure to
 * answer in time; a cancel is the caller's, and stays an abort.
 */
function transportFailure(
  error: unknown,
  signal: AbortSignal,
  what: string,
): unknown {
  if (signal.aborted) {
    return isTimeout(signal.reason)
      ? new StatelessUpstreamError("The MCP server did not answer in time.")
      : error;
  }
  return new StatelessUpstreamError(
    `The MCP server ${what}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
