import type { ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyReply } from "fastify";

/** Server-Timing covers non-streaming responses through serialization, before socket delivery. */
class LlmProxyTiming {
  private readonly requests = new WeakMap<
    ServerResponse,
    {
      start: number;
      upstreamMs: number;
      calls: number;
      pending: number;
    }
  >();

  register(fastify: FastifyInstance): void {
    fastify.addHook("onRequest", (request, reply, done) => {
      if (request.routeOptions.url?.startsWith("/v1/")) {
        this.requests.set(reply.raw, {
          start: performance.now(),
          upstreamMs: 0,
          calls: 0,
          pending: 0,
        });
      }
      done();
    });
    fastify.addHook("onSend", (_request, reply, _payload, done) => {
      const timing = this.requests.get(reply.raw);
      this.requests.delete(reply.raw);
      if (
        timing?.calls &&
        !timing.pending &&
        reply.statusCode < 400 &&
        !reply.raw.headersSent
      ) {
        const gatewayMs = performance.now() - timing.start;
        // The SDK call includes upstream transport and decoding. Excluding it
        // leaves auth, routing, policies, persistence and serialization time.
        const overheadMs = Math.max(0, gatewayMs - timing.upstreamMs);
        reply.header(
          "Server-Timing",
          [
            `archestra_gateway;dur=${gatewayMs.toFixed(3)}`,
            `archestra_upstream;dur=${timing.upstreamMs.toFixed(3)}`,
            `archestra_overhead;dur=${overheadMs.toFixed(3)}`,
          ].join(", "),
        );
      }
      done();
    });
  }

  async upstream<T>(reply: FastifyReply, open: () => Promise<T>): Promise<T> {
    const timing = this.requests.get(reply.raw);
    if (!timing) return open();
    // Concurrent calls cannot be summed into a wall-clock overhead. Keep those
    // responses unmeasured rather than publishing an invalid subtraction.
    if (timing.pending) {
      this.requests.delete(reply.raw);
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
}

export const llmProxyTiming = new LlmProxyTiming();
