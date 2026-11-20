import { request } from "node:http";
import { Readable } from "node:stream";
import { llmUpstreamFetch } from "@/clients/llm-upstream-fetch";
import config from "@/config";

const framedResponses = new WeakSet<Response>();

export function isRustOpenAiFramedResponse(response: Response): boolean {
  return framedResponses.has(response);
}

export function openAiStreamFetch(
  input: Parameters<typeof llmUpstreamFetch>[0],
  init: Parameters<typeof llmUpstreamFetch>[1],
  dispatcher: Parameters<typeof llmUpstreamFetch>[2],
  onDispatch?: () => void,
): Promise<Response> {
  if (
    input instanceof Request ||
    init?.method?.toUpperCase() !== "POST" ||
    typeof init.body !== "string" ||
    !acceptsNativeRelay(String(input), dispatcher) ||
    !isStream(init.body)
  ) {
    return llmUpstreamFetch(input, init, dispatcher);
  }
  const socketPath = config.database.rustAuditLogSocket;
  if (!socketPath)
    return Promise.reject(
      new TypeError("Rust OpenAI stream socket is not configured"),
    );
  return relay({
    socketPath,
    url: String(input),
    headers: [...new Headers(init.headers)],
    body: init.body,
    signal: init.signal ?? undefined,
    onDispatch,
  });
}

/** The SDK builds the chat URL before fetch; no request has been sent yet. */
export function canUseRustOpenAiChatRelay(
  baseUrl: string | undefined,
): boolean {
  const base =
    baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const url = URL.parse(`${base.replace(/\/$/, "")}/chat/completions`);
  return (
    !!url &&
    !!config.database.rustAuditLogSocket &&
    !config.llmProxy.upstreamTimeoutMs &&
    acceptsNativeRelay(url.href)
  );
}

function acceptsNativeRelay(
  url: string,
  dispatcher?: Parameters<typeof llmUpstreamFetch>[2],
): boolean {
  return (
    config.llmProxy.rustOpenAiStreamEnabled &&
    !dispatcher &&
    !process.env.HTTP_PROXY &&
    !process.env.HTTPS_PROXY &&
    !process.env.ALL_PROXY &&
    !process.env.http_proxy &&
    !process.env.https_proxy &&
    !process.env.all_proxy &&
    process.env.NODE_USE_ENV_PROXY !== "1" &&
    !process.env.NODE_EXTRA_CA_CERTS &&
    process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0" &&
    url ===
      `${config.llm.openai.baseUrl.replace(/\/+$/, "")}/chat/completions` &&
    isSupportedTarget(url)
  );
}

function isSupportedTarget(value: string): boolean {
  const url = URL.parse(value);
  return (
    !!url &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    ((url.origin === "https://api.openai.com" &&
      url.pathname === "/v1/chat/completions") ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
  );
}

function isStream(body: string): boolean {
  try {
    return JSON.parse(body)?.stream === true;
  } catch {
    return false;
  }
}

function relay(params: {
  socketPath: string;
  url: string;
  headers: [string, string][];
  body: string;
  signal?: AbortSignal;
  onDispatch?: () => void;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    params.signal?.throwIfAborted();
    const failBridge = () => {
      if (params.signal?.aborted) {
        reject(params.signal.reason);
        return;
      }
      // A broken relay may already have sent the upstream POST. Do not retry
      // it as a status-less connection error.
      resolve(
        Response.json(
          { error: { message: "Rust OpenAI transport failed" } },
          { status: 502 },
        ),
      );
    };
    const req = request(
      {
        method: "POST",
        path: "/internal/v1/openai/chat-stream",
        socketPath: params.socketPath,
        signal: params.signal,
        agent: false,
        headers: { "content-type": "application/json" },
      },
      (upstream) => {
        const status = Number(upstream.headers["x-archestra-upstream-status"]);
        if (
          upstream.statusCode !== 200 ||
          !Number.isInteger(status) ||
          status < 200 ||
          status > 599
        ) {
          upstream.destroy();
          failBridge();
          return;
        }
        const headers = new Headers();
        for (
          let index = 0;
          index + 1 < upstream.rawHeaders.length;
          index += 2
        ) {
          const name = upstream.rawHeaders[index];
          if (
            name &&
            ![
              "x-archestra-upstream-status",
              "x-archestra-openai-frames",
              "connection",
              "transfer-encoding",
            ].includes(name.toLowerCase())
          ) {
            headers.append(name, upstream.rawHeaders[index + 1] ?? "");
          }
        }
        const nullBody = status === 204 || status === 205 || status === 304;
        if (nullBody) upstream.resume();
        const body = nullBody
          ? null
          : (Readable.toWeb(upstream) as ReadableStream);
        const response = new Response(body, { status, headers });
        if (upstream.headers["x-archestra-openai-frames"] === "1") {
          framedResponses.add(response);
        }
        resolve(response);
      },
    );
    req.on("error", failBridge);
    req.end(
      JSON.stringify({
        url: params.url,
        headers: params.headers,
        body: params.body,
      }),
    );
    params.onDispatch?.();
  });
}
