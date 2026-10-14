import { ApiError } from "@archestra/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { drainBackgroundWork } from "@/utils/background-work";

/** Includes the handler's post-stream persistence, not just HTTP completion. */
export function registerLlmProxyDrain(
  fastify: FastifyInstance,
  graceMs = 60_000,
) {
  const drain = new LlmProxyDrain(fastify, graceMs);
  drains.set(fastify, drain);
  return drain;
}

/** Reject new proxy work immediately, before other shutdown cleanup awaits. */
export function beginLlmProxyDrain(fastify: FastifyInstance): void {
  drains.get(fastify)?.beginShutdown();
}

class LlmProxyDrain {
  private deadline: number | undefined;
  private readonly active = new Set<() => void>();
  private readonly requests = new WeakMap<FastifyRequest, RequestState>();
  private drained: (() => void) | undefined;

  constructor(
    fastify: FastifyInstance,
    private readonly graceMs: number,
  ) {
    fastify.addHook("onRequest", (request, reply, done) => {
      const path = request.routeOptions.url;
      if (
        this.deadline !== undefined &&
        (isProxyRoute(path) || path === "/ready")
      ) {
        reply.header("Connection", "close");
        reply.header("Retry-After", "1");
        // /ready has its own 503 schema; shutdown uses the standard error envelope.
        reply.serializer(JSON.stringify);
        done(new ApiError(503, "Server is shutting down"));
        return;
      }
      if (isProxyRoute(path)) {
        const state: RequestState = { handlerDone: true, responseDone: false };
        this.requests.set(request, state);
        const release = () => {
          if (!state.handlerDone || !state.responseDone) return;
          this.active.delete(release);
          this.requests.delete(request);
          reply.raw.removeListener("finish", responseDone);
          reply.raw.removeListener("close", responseDone);
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
      }
      done();
    });

    fastify.addHook("onRoute", (route) => {
      if (!isProxyRoute(route.url)) return;
      const handler = route.handler;
      const drain = this;
      route.handler = function (request, reply) {
        const state = drain.requests.get(request);
        // A disconnect can release admission while an async hook is still
        // pending. Its eventual completion must not start untracked proxy work.
        if (!state || reply.raw.destroyed) return;
        state.handlerDone = false;
        const finish = () => {
          state.handlerDone = true;
          state.release?.();
        };
        try {
          const result = handler.call(this, request, reply);
          if (
            result &&
            typeof (result as PromiseLike<unknown>).then === "function"
          ) {
            return Promise.resolve(result).finally(finish);
          }
          // reply.from() starts callback-driven I/O and returns undefined.
          // Turning that into a promise makes Fastify send an empty response.
          finish();
          return result;
        } catch (error) {
          finish();
          throw error;
        }
      };
    });

    // Fastify already drains HTTP sockets. Wait here as well because a raw
    // response can finish before its handler's finally block persists usage.
    // preClose runs before any dependency-owning onClose hooks.
    fastify.addHook("preClose", async () => {
      this.beginShutdown();
      let timeout: NodeJS.Timeout | undefined;
      try {
        const completed = await Promise.race([
          (async () => {
            if (this.active.size > 0) {
              await new Promise<void>((resolve) => {
                this.drained = resolve;
              });
            }
            // Interaction creation launches usage updates in the background.
            // Keep persistence dependencies alive until those settle too.
            await drainBackgroundWork();
            return true;
          })(),
          new Promise<false>((resolve) => {
            timeout = setTimeout(
              () => resolve(false),
              Math.max(0, (this.deadline ?? Date.now()) - Date.now()),
            );
          }),
        ]);
        if (!completed) {
          fastify.log.warn(
            { activeRequests: this.active.size },
            "LLM proxy drain timed out; closing remaining connections",
          );
          fastify.server.closeAllConnections();
        }
      } finally {
        clearTimeout(timeout);
        this.drained = undefined;
      }
    });
  }

  beginShutdown(): void {
    this.deadline ??= Date.now() + this.graceMs;
  }
}

type RequestState = {
  handlerDone: boolean;
  responseDone: boolean;
  release?: () => void;
};

function isProxyRoute(path: string | undefined): boolean {
  return (
    path?.startsWith("/v1/") === true &&
    path !== "/v1/health" &&
    path !== "/v1/mcp" &&
    !path.startsWith("/v1/mcp/")
  );
}

const drains = new WeakMap<FastifyInstance, LlmProxyDrain>();
