import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { RunnerLabelModel, RunnerModel } from "@/models";
import { preflightRunnerCredentials } from "@/services/runners/credentials";
import {
  AgentLabelWithDetailsSchema,
  ApiError,
  constructResponseSchema,
  InsertRunnerSchema,
  MissingRunnerCredentialSchema,
  type Runner,
  SelectRunnerWithLabelsSchema,
  UpdateRunnerSchema,
} from "@/types";
import {
  BulkDeleteBodySchema,
  BulkOutcomeSchema,
  runBulk,
} from "../bulk-route";

const RunnerBodySchema = InsertRunnerSchema.omit({
  organizationId: true,
}).extend({
  /** Omitted leaves existing labels untouched; `[]` clears them. */
  labels: z.array(AgentLabelWithDetailsSchema).optional(),
});

const RunnerUpdateBodySchema = UpdateRunnerSchema.extend({
  labels: z.array(AgentLabelWithDetailsSchema).optional(),
});

const runnerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/runners",
    {
      schema: {
        operationId: RouteId.GetAllRunners,
        description: "List runner definitions in the organization",
        tags: ["Runners"],
        querystring: z.object({
          search: z.string().trim().min(1).optional(),
          environmentId: z.string().uuid().optional(),
          /** `key:a|b;key2:c` — a runner must match every key. */
          labels: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
        response: constructResponseSchema(
          z.object({
            runners: z.array(SelectRunnerWithLabelsSchema),
            total: z.number(),
          }),
        ),
      },
    },
    async ({ query, organizationId }, reply) => {
      assertRunnersEnabled();
      return reply.send(
        await RunnerModel.list({
          organizationId,
          search: query.search,
          environmentId: query.environmentId,
          labels: parseLabelsFilter(query.labels),
          limit: query.limit,
          offset: query.offset,
        }),
      );
    },
  );

  fastify.get(
    "/api/runners/:id",
    {
      schema: {
        operationId: RouteId.GetRunner,
        description: "Get a runner definition",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(SelectRunnerWithLabelsSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      assertRunnersEnabled();
      const runner = await requireRunner(params.id, organizationId);
      return reply.send({
        ...runner,
        labels: await RunnerLabelModel.getLabelsForRunner(runner.id),
      });
    },
  );

  fastify.get(
    "/api/runners/labels/keys",
    {
      schema: {
        operationId: RouteId.GetRunnerLabelKeys,
        description: "Label keys in use by this organization's runners",
        tags: ["Runners"],
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ organizationId }, reply) => {
      assertRunnersEnabled();
      return reply.send(await RunnerLabelModel.getAllKeys(organizationId));
    },
  );

  fastify.get(
    "/api/runners/labels/values",
    {
      schema: {
        operationId: RouteId.GetRunnerLabelValues,
        description: "Label values in use by this organization's runners",
        tags: ["Runners"],
        querystring: z.object({
          key: z.string().optional().describe("Filter values by label key"),
        }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ query: { key }, organizationId }, reply) => {
      assertRunnersEnabled();
      return reply.send(
        key
          ? await RunnerLabelModel.getValuesByKey({ organizationId, key })
          : await RunnerLabelModel.getAllValues(organizationId),
      );
    },
  );

  /**
   * What the current user still has to supply before a session on this runner
   * can start. Lets a caller annotate up front rather than failing on start.
   */
  fastify.get(
    "/api/runners/:id/preflight",
    {
      schema: {
        operationId: RouteId.GetRunnerPreflight,
        description:
          "Report credentials the current user must supply before this runner can act as them",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({
            ready: z.boolean(),
            missing: z.array(MissingRunnerCredentialSchema),
            misconfigured: z.array(MissingRunnerCredentialSchema),
          }),
        ),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      assertRunnersEnabled();
      const runner = await requireRunner(params.id, organizationId);
      const preflight = await preflightRunnerCredentials({
        runner,
        organizationId,
        userId: user.id,
      });
      return reply.send({
        ready:
          preflight.missing.length === 0 &&
          preflight.misconfigured.length === 0,
        ...preflight,
      });
    },
  );

  fastify.post(
    "/api/runners",
    {
      schema: {
        operationId: RouteId.CreateRunner,
        description: "Create a runner definition",
        tags: ["Runners"],
        body: RunnerBodySchema,
        response: constructResponseSchema(SelectRunnerWithLabelsSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      assertRunnersEnabled();
      await assertMayConfigurePrivileged({
        privileged: body.privileged === true,
        userId: user.id,
        organizationId,
      });
      const { labels, ...values } = body;
      const created = await RunnerModel.create(
        { ...values, organizationId },
        labels,
      );
      return reply.send({ ...created, labels: labels ?? [] });
    },
  );

  fastify.put(
    "/api/runners/:id",
    {
      schema: {
        operationId: RouteId.UpdateRunner,
        description: "Update a runner definition",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        body: RunnerUpdateBodySchema,
        response: constructResponseSchema(SelectRunnerWithLabelsSchema),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      assertRunnersEnabled();
      await assertMayConfigurePrivileged({
        privileged: body.privileged === true,
        userId: user.id,
        organizationId,
      });
      const { labels, ...values } = body;
      const updated = await RunnerModel.update(
        params.id,
        organizationId,
        values,
        labels,
      );
      if (!updated) {
        throw new ApiError(404, "Runner not found");
      }
      return reply.send({
        ...updated,
        labels: await RunnerLabelModel.getLabelsForRunner(updated.id),
      });
    },
  );

  fastify.delete(
    "/api/runners/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteRunners,
        description: "Delete runner definitions",
        tags: ["Runners"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      assertRunnersEnabled();
      const { organizationId } = request;
      return reply.send(
        await runBulk({
          ids: request.body.ids,
          logLabel: "runners bulk delete",
          notFoundMessage: "Runner not found",
          unexpectedMessage: "Could not delete this runner",
          load: async (ids) => {
            const loaded = new Map<string, Runner>();
            for (const id of ids) {
              const runner = await RunnerModel.findById(id, organizationId);
              if (runner) loaded.set(id, runner);
            }
            return loaded;
          },
          describe: (runner) => runner.name,
          applyEach: async (_runner, id) => {
            const deleted = await RunnerModel.delete(id, organizationId);
            if (!deleted) throw new ApiError(404, "Runner not found");
          },
          audit: {
            target: request,
            snapshot: async (ids) => ({ ids }),
          },
        }),
      );
    },
  );

  fastify.delete(
    "/api/runners/:id",
    {
      schema: {
        operationId: RouteId.DeleteRunner,
        description: "Delete a runner definition",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      assertRunnersEnabled();
      const deleted = await RunnerModel.delete(params.id, organizationId);
      if (!deleted) {
        throw new ApiError(404, "Runner not found");
      }
      return reply.send({ deleted });
    },
  );
};

export default runnerRoutes;

// ===================== internals =====================

function assertRunnersEnabled(): void {
  // 404 rather than 403: a disabled feature is invisible, not forbidden.
  if (!runnerRuntimeManager.isEnabled) {
    throw new ApiError(404, "Not found");
  }
}

async function requireRunner(
  id: string,
  organizationId: string,
): Promise<Runner> {
  const runner = await RunnerModel.findById(id, organizationId);
  if (!runner) {
    throw new ApiError(404, "Runner not found");
  }
  return runner;
}

/**
 * A privileged pod holds host devices and full capabilities, so configuring
 * one is node-level access rather than a runner setting.
 */
async function assertMayConfigurePrivileged(params: {
  privileged: boolean;
  userId: string;
  organizationId: string;
}): Promise<void> {
  if (!params.privileged) return;
  const { userHasPermission } = await import("@/auth/utils");
  const mayGrant = await userHasPermission(
    params.userId,
    params.organizationId,
    "runner",
    "admin",
  );
  if (!mayGrant) {
    throw new ApiError(
      403,
      "Only a runner administrator can configure a privileged runner",
    );
  }
}

/** `key:a|b;key2:c` into the shape the model filters on. */
function parseLabelsFilter(
  raw: string | undefined,
): Record<string, string[]> | undefined {
  if (!raw) return undefined;
  const parsed: Record<string, string[]> = {};
  for (const entry of raw.split(";")) {
    const [key, values] = entry.split(":");
    if (!key || !values) continue;
    parsed[key] = values.split("|").filter(Boolean);
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}
