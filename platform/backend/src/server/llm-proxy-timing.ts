import { AsyncLocalStorage } from "node:async_hooks";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Server-Timing for gateway responses (LLM proxy and MCP gateway) covers
 * non-streaming responses through serialization, before socket delivery.
 */
class LlmProxyTiming {
  private readonly requests = new WeakMap<ServerResponse, Timing>();
  private readonly hijackedRequest = new AsyncLocalStorage<Timing>();

  register(fastify: FastifyInstance): void {
    fastify.addHook("onRequest", (request, reply, done) => {
      if (request.routeOptions.url?.startsWith("/v1/")) {
        this.requests.set(reply.raw, {
          start: performance.now(),
          upstreamMs: 0,
          calls: 0,
          pending: 0,
          concurrent: false,
        });
      }
      done();
    });
    fastify.addHook("onSend", (_request, reply, _payload, done) => {
      const timing = this.requests.get(reply.raw);
      this.requests.delete(reply.raw);
      const header =
        timing && reply.statusCode < 400 && !reply.raw.headersSent
          ? serverTiming(timing)
          : null;
      if (header) reply.header("Server-Timing", header);
      done();
    });
  }

  async upstream<T>(reply: FastifyReply, open: () => Promise<T>): Promise<T> {
    const timing = this.requests.get(reply.raw);
    return timing ? measure(timing, open) : open();
  }

  /**
   * For a route that writes the raw response itself after `reply.hijack()`,
   * so `onSend` never runs: upstream calls made while `handle` runs are timed
   * through `hijackedUpstream`, and the header joins the response head.
   */
  async hijacked<T>(reply: FastifyReply, handle: () => Promise<T>): Promise<T> {
    const timing = this.requests.get(reply.raw);
    if (!timing) return handle();
    this.requests.delete(reply.raw);
    const response = reply.raw;
    const writeHead = response.writeHead;
    response.writeHead = function (
      this: ServerResponse,
      statusCode: number,
      ...rest: unknown[]
    ) {
      response.writeHead = writeHead;
      const header = statusCode < 400 ? serverTiming(timing) : null;
      if (header) {
        // Headers passed to writeHead win over setHeader, so add to them.
        const headers = rest.find(
          (value): value is OutgoingHttpHeaders =>
            typeof value === "object" && value !== null,
        );
        if (headers && !Array.isArray(headers))
          headers["Server-Timing"] = header;
        else response.setHeader("Server-Timing", header);
      }
      return writeHead.call(
        this,
        statusCode,
        ...(rest as []),
      ) as ServerResponse;
    } as ServerResponse["writeHead"];
    return this.hijackedRequest.run(timing, handle);
  }

  /** Time an upstream call made inside `hijacked`; a no-op elsewhere. */
  async hijackedUpstream<T>(open: () => Promise<T>): Promise<T> {
    const timing = this.hijackedRequest.getStore();
    return timing ? measure(timing, open) : open();
  }
}

export const llmProxyTiming = new LlmProxyTiming();

type Timing = {
  start: number;
  upstreamMs: number;
  calls: number;
  pending: number;
  /** Overlapping calls cannot be summed into a wall-clock overhead. */
  concurrent: boolean;
};

async function measure<T>(timing: Timing, open: () => Promise<T>): Promise<T> {
  // Keep those responses unmeasured rather than publishing an invalid
  // subtraction.
  if (timing.pending) {
    timing.concurrent = true;
    return open();
  }
  const start = performance.now();
  timing.pending++;
  try {
    return await open();
  } finally {
    timing.upstreamMs += performance.now() - start;
    timing.calls++;
    timing.pending--;
  }
}

function serverTiming(timing: Timing): string | null {
  if (!timing.calls || timing.pending || timing.concurrent) return null;
  const gatewayMs = performance.now() - timing.start;
  // The upstream call includes transport and decoding. Excluding it leaves
  // auth, routing, policies, persistence and serialization time.
  const overheadMs = Math.max(0, gatewayMs - timing.upstreamMs);
  return [
    `archestra_gateway;dur=${gatewayMs.toFixed(3)}`,
    `archestra_upstream;dur=${timing.upstreamMs.toFixed(3)}`,
    `archestra_overhead;dur=${overheadMs.toFixed(3)}`,
  ].join(", ");
}
