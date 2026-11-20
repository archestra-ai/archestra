import { AsyncLocalStorage } from "node:async_hooks";
import { request as requestHttp } from "node:http";
import { Readable } from "node:stream";

export const remoteMcpCall = new AsyncLocalStorage<{
  socketPath: string;
  endpoint: string;
  sessionId?: string;
  signal: AbortSignal;
  dispatched: boolean;
}>();

export function nativeRemoteMcpFetch(endpoint: URL): typeof fetch {
  return (input, init) => {
    const call = remoteMcpCall.getStore();
    if (!call) return fetch(input, init);
    // The SDK may try to resume an SSE response after the relay is aborted.
    if (call.dispatched && call.signal.aborted && init?.method === "GET") {
      return Promise.reject(call.signal.reason);
    }
    const headers = new Headers(init?.headers);
    if (
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      JSON.parse(init.body)?.method !== "tools/call"
    ) {
      return fetch(input, init);
    }
    if (call.dispatched) throw new Error("Remote MCP call already dispatched");
    if (headers.get("mcp-session-id") !== (call.sessionId ?? null)) {
      throw new Error("Remote MCP session changed after admission");
    }
    if (call.endpoint !== endpoint.href || String(input) !== endpoint.href) {
      throw new Error("Remote MCP destination changed after admission");
    }
    call.dispatched = true;
    return new Promise<Response>((resolve, reject) => {
      const request = requestHttp(
        {
          socketPath: call.socketPath,
          agent: false,
          path: "/internal/v1/mcp/remote-call",
          method: "POST",
          signal: init.signal
            ? AbortSignal.any([call.signal, init.signal])
            : call.signal,
          headers: { "content-type": "application/json" },
        },
        (reply) => {
          const status = Number(reply.headers["x-archestra-upstream-status"]);
          if (
            reply.statusCode !== 200 ||
            !Number.isInteger(status) ||
            status < 200 ||
            status > 599
          ) {
            reply.resume();
            reject(new Error("Native remote MCP transport failed"));
            return;
          }
          const responseHeaders = new Headers();
          for (const name of [
            "content-type",
            "www-authenticate",
            "mcp-session-id",
          ]) {
            const value = reply.headers[name];
            if (typeof value === "string") responseHeaders.set(name, value);
          }
          const empty = [204, 205, 304].includes(status);
          if (empty) reply.resume();
          resolve(
            new Response(
              empty ? null : (Readable.toWeb(reply) as ReadableStream),
              {
                status,
                headers: responseHeaders,
              },
            ),
          );
        },
      );
      request.once("error", reject);
      request.end(
        JSON.stringify({
          url: endpoint.href,
          headers: [...headers],
          body: init.body,
        }),
      );
    });
  };
}
