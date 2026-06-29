import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { isDatabaseHealthy } from "@/database";
import type { SandboxRuntimeStatus } from "@/sandbox-runtime/sandbox-runtime-service";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { HEALTH_PATH, READY_PATH } from "./route-paths";

const { name, version } = config.api;

const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Lightweight liveness check — only verifies the HTTP server is running.
   */
  fastify.get(
    HEALTH_PATH,
    {
      schema: {
        tags: ["Health"],
        response: {
          200: z.object({
            name: z.string(),
            status: z.literal("ok"),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      name,
      status: "ok" as const,
      version,
    }),
  );

  /**
   * Readiness check — verifies database connectivity.
   * Returns 200 if ready to receive traffic, 503 otherwise.
   */
  fastify.get(
    READY_PATH,
    {
      schema: {
        tags: ["Health"],
        response: {
          200: z.object({
            name: z.string(),
            status: z.enum(["ok", "maintenance"]),
            version: z.string(),
            database: z.enum(["connected", "not_checked"]),
            // Code-execution sandbox readiness. Consumers (e.g. the benchmark
            // runner) fail fast on `disabled`/`unreachable` instead of waiting
            // out their readiness deadline. `sandboxReason` carries the
            // underlying boot state for triage.
            sandbox: z.enum([
              "ready",
              "initializing",
              "disabled",
              "unreachable",
            ]),
            sandboxReason: z.string().optional(),
          }),
          503: z.object({
            name: z.string(),
            status: z.literal("degraded"),
            version: z.string(),
            database: z.literal("disconnected"),
          }),
        },
      },
    },
    async (request, reply) => {
      // Build the shared 200 fields at the moment of responding, reading the
      // cached boot status only — never triggering a sandbox probe. A single
      // definition keeps the two 200 branches from diverging; calling it per
      // branch keeps the snapshot consistent with the response (no stale read
      // held across the DB await below).
      const ready200 = () => ({
        name,
        version,
        ...mapSandboxStatus(skillSandboxRuntimeService.bootStatus),
      });

      // Maintenance mode must stay available while the database is offline or
      // being upgraded, so readiness intentionally skips the DB probe here.
      if (config.maintenanceMode) {
        return reply.send({
          ...ready200(),
          status: "maintenance",
          database: "not_checked",
        });
      }

      const dbHealthy = await isDatabaseHealthy();

      if (!dbHealthy) {
        request.log.warn("Database health check failed for readiness probe");
        return reply.status(503).send({
          name,
          status: "degraded",
          version,
          database: "disconnected",
        });
      }

      return reply.send({ ...ready200(), status: "ok", database: "connected" });
    },
  );
};

export default healthRoutes;

type SandboxReadyState = "ready" | "initializing" | "disabled" | "unreachable";

/**
 * Map the sandbox runtime's internal boot status onto the `/ready` contract.
 * `error` and `stopped` collapse to `unreachable` (a consumer cannot run the
 * sandbox in either state); the original state is preserved in `sandboxReason`.
 *
 * @public — exported for unit tests.
 */
export function mapSandboxStatus(status: SandboxRuntimeStatus): {
  sandbox: SandboxReadyState;
  sandboxReason?: string;
} {
  switch (status) {
    case "ready":
      return { sandbox: "ready" };
    case "initializing":
      return { sandbox: "initializing" };
    case "disabled":
      return { sandbox: "disabled", sandboxReason: "disabled" };
    case "error":
      return { sandbox: "unreachable", sandboxReason: "error" };
    case "stopped":
      return { sandbox: "unreachable", sandboxReason: "stopped" };
    default:
      return assertNever(status);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled sandbox runtime status "${value}".`);
}
