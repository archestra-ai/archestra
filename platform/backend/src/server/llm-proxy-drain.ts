import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ServerDrainingError } from "@/types/server-draining-error";
import { drainBackgroundWork } from "@/utils/background-work";
import { takeDrainScope, withDrainScope } from "@/utils/drain-scope";

/** Tracks admitted handlers, responses and their background persistence. */
export function registerLlmProxyDrain(
  fastify: FastifyInstance,
  graceMs = 60_000,
) {
  const drain = new RequestDrain(fastify, graceMs);
  drains.set(fastify, drain);
  return drain;
}

export function beginLlmProxyDrain(fastify: FastifyInstance): void {
  drains.get(fastify)?.beginShutdown();
}

/** Run before Fastify.close(), which otherwise rejects active MCP replies. */
export async function drainLlmProxyRequests(
  fastify: FastifyInstance,
): Promise<void> {
  await drains.get(fastify)?.drain();
}

/** Notification streams end after admitted calls; they are not drain work themselves. */
export function registerShutdownStream(
  request: FastifyRequest,
  reply: FastifyReply,
  close = () => {
    reply.raw.end();
  },
): void {
  requestDrains.get(request)?.registerStream(request, reply.raw, close);
}

/** A legacy message acknowledged before shutdown may still need its loopback hop. */
export async function withDrainContinuation<T>(
  request: FastifyRequest,
  run: (token: string | undefined) => Promise<T>,
): Promise<T> {
  const drain = requestDrains.get(request);
  const token = drain?.createContinuation();
  try {
    return await run(token);
  } finally {
    if (token) drain?.forgetContinuation(token);
  }
}

class RequestDrain {
  private deadline: number | undefined;
  private readonly active = new Set<() => void>();
  private readonly continuations = new Set<string>();
  private readonly streams = new Map<ServerResponse, () => void>();
  private readonly requests = new WeakMap<FastifyRequest, RequestState>();
  private drained: (() => void) | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly fastify: FastifyInstance,
    private readonly graceMs: number,
  ) {
    fastify.addHook("onRequest", (request, reply, done) => {
      const path = request.routeOptions.url;
      const continuation = takeDrainScope(request);
      if (
        this.deadline !== undefined &&
        (path === "/ready" ||
          (!isProbe(path) &&
            (!continuation || performance.now() >= this.deadline) &&
            !isMcpRoute(path)))
      ) {
        reply.header("Connection", "close").header("Retry-After", "1");
        reply.serializer(JSON.stringify);
        done(new ServerDrainingError());
        return;
      }
      if (isProbe(path) || request.headers.upgrade) return done();
      const state: RequestState = {
        handlerDone: true,
        responseDone: false,
        longLived: false,
        continuation,
      };
      this.requests.set(request, state);
      requestDrains.set(request, this);
      const release = () => {
        if (!state.longLived && (!state.handlerDone || !state.responseDone))
          return;
        this.active.delete(release);
        if (state.responseDone) {
          this.requests.delete(request);
          requestDrains.delete(request);
          this.streams.delete(reply.raw);
          reply.raw.removeListener("finish", responseDone);
          reply.raw.removeListener("close", responseDone);
        }
        if (this.active.size === 0) this.drained?.();
      };
      const responseDone = () => {
        state.responseDone = true;
        release();
      };
      state.release = release;
      this.active.add(release);
      reply.raw.once("finish", responseDone);
      reply.raw.once("close", responseDone);
      done();
    });

    fastify.addHook("preValidation", (request, reply, done) => {
      const path = request.routeOptions.url;
      const body = request.body as { method?: unknown } | undefined;
      if (this.deadline !== undefined && isMcpRoute(path)) {
        // JSON-RPC responses and cancellation notifications finish existing work.
        // Authentication and pending-request ownership are still checked by the route.
        const replayToken = request.headers["x-archestra-drain-continuation"];
        const admittedReplay =
          typeof replayToken === "string" &&
          this.continuations.delete(replayToken);
        const continuation =
          request.method === "POST" &&
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          ((!("method" in body) && ("result" in body || "error" in body)) ||
            body.method === "notifications/cancelled");
        const admittedScope =
          this.requests.get(request)?.continuation &&
          performance.now() < this.deadline;
        if (
          !admittedScope &&
          !admittedReplay &&
          (!continuation || this.active.size <= 1)
        ) {
          reply.header("Connection", "close").header("Retry-After", "1");
          reply.serializer(JSON.stringify);
          done(new ServerDrainingError());
          return;
        }
      }
      done();
    });

    fastify.addHook("onRoute", (route) => {
      if (isProbe(route.url)) return;
      const handler = route.handler;
      const drain = this;
      route.handler = function (request, reply) {
        const state = drain.requests.get(request);
        if (request.headers.upgrade) return handler.call(this, request, reply);
        if (!state || reply.raw.destroyed) return;
        state.handlerDone = false;
        const finish = () => {
          state.handlerDone = true;
          state.release?.();
        };
        try {
          const result = withDrainScope(
            () => handler.call(this, request, reply),
            state.continuation,
          );
          if (
            result &&
            typeof (result as PromiseLike<unknown>).then === "function"
          )
            return Promise.resolve(result).finally(finish);
          finish();
          return result;
        } catch (error) {
          finish();
          throw error;
        }
      };
    });
    fastify.addHook("preClose", () => this.drain());
  }

  createContinuation(): string {
    const token = randomUUID();
    this.continuations.add(token);
    return token;
  }

  forgetContinuation(token: string): void {
    this.continuations.delete(token);
  }

  registerStream(
    request: FastifyRequest,
    response: ServerResponse,
    close: () => void,
  ): void {
    const state = this.requests.get(request);
    if (!state) return;
    state.longLived = true;
    this.streams.set(response, close);
    state.release?.();
  }

  beginShutdown(): void {
    // Clock synchronization must not shorten or extend the shutdown grace.
    this.deadline ??= performance.now() + this.graceMs;
  }

  drain(): Promise<void> {
    this.beginShutdown();
    this.draining ??= this.waitForDrain();
    return this.draining;
  }

  private async waitForDrain(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const completed = await Promise.race([
        (async () => {
          do {
            if (this.active.size > 0)
              await new Promise<void>((resolve) => {
                this.drained = resolve;
              });
            await setImmediate(); // finish/onResponse hooks may launch audit writes
            await drainBackgroundWork();
            // Socket work can start a loopback handler after the previous
            // active-request check, then finish before that handler persists.
          } while (this.active.size > 0);
          // End notification streams only after their outstanding calls finish.
          for (const close of this.streams.values()) close();
          await setImmediate(); // finish/onResponse hooks may launch audit writes
          await drainBackgroundWork();
          return true;
        })(),
        new Promise<false>((resolve) => {
          timeout = setTimeout(
            () => resolve(false),
            Math.max(
              0,
              (this.deadline ?? performance.now()) - performance.now(),
            ),
          );
        }),
      ]);
      if (!completed) {
        this.fastify.log.warn(
          { activeRequests: this.active.size },
          "Request drain timed out; closing remaining connections",
        );
        for (const close of this.streams.values()) close();
        this.fastify.server.closeAllConnections();
      }
    } finally {
      clearTimeout(timeout);
      this.drained = undefined;
    }
  }
}

type RequestState = {
  handlerDone: boolean;
  responseDone: boolean;
  longLived: boolean;
  continuation?: string;
  release?: () => void;
};
function isProbe(path: string | undefined): boolean {
  return (
    path === "/health" ||
    path === "/ready" ||
    path === "/v1/health" ||
    path === "/metrics"
  );
}
function isMcpRoute(path: string | undefined): boolean {
  return (
    path === "/v1/mcp" ||
    path?.startsWith("/v1/mcp/") === true ||
    path?.startsWith("/api/mcp/") === true ||
    path?.startsWith("/mcp_proxy/") === true
  );
}
const drains = new WeakMap<FastifyInstance, RequestDrain>();

const requestDrains = new WeakMap<FastifyRequest, RequestDrain>();
