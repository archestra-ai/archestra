import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import logger from "@/logging";
import {
  AgentModel,
  EnvironmentModel,
  OrganizationModel,
  RunnerEventModel,
  RunnerModel,
} from "@/models";
import { preflightRunnerCredentials } from "@/services/runners/credentials";
import {
  buildRunnerLaunchSpec,
  RunnerCredentialsRequiredError,
} from "@/services/runners/launch-spec";
import {
  ApiError,
  constructResponseSchema,
  MissingRunnerCredentialSchema,
  RUNNER_CREDENTIALS_REQUIRED_CODE,
  type Runner,
  RunnerStateSchema,
  SelectRunnerEventSchema,
  SelectRunnerSchema,
  type User,
} from "@/types";

const RunnerResponseSchema = SelectRunnerSchema;

const CreateRunnerBodySchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(200),
  /** Initial instruction handed to the agent when the session starts. */
  task: z.string().max(20_000).optional(),
});

const SteerRunnerBodySchema = z.object({
  message: z.string().min(1).max(20_000),
});

const runnerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/runners",
    {
      schema: {
        operationId: RouteId.GetAllRunners,
        description: "List runners in the organization",
        tags: ["Runners"],
        querystring: z.object({
          agentId: z.string().uuid().optional(),
          state: RunnerStateSchema.optional(),
          /** Restrict to the caller's own runners. */
          mine: z.coerce.boolean().optional(),
        }),
        response: constructResponseSchema(z.array(RunnerResponseSchema)),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const runners = await RunnerModel.list({
        organizationId,
        agentId: query.agentId,
        createdByUserId: query.mine ? user.id : undefined,
        states: query.state ? [query.state] : undefined,
      });
      return reply.send(runners);
    },
  );

  fastify.get(
    "/api/runners/:id",
    {
      schema: {
        operationId: RouteId.GetRunner,
        description: "Get a runner",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(RunnerResponseSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      return reply.send(await requireRunner(params.id, organizationId));
    },
  );

  fastify.get(
    "/api/runners/:id/events",
    {
      schema: {
        operationId: RouteId.GetRunnerEvents,
        description: "Get a runner's session timeline",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.array(SelectRunnerEventSchema)),
      },
    },
    async ({ params, organizationId }, reply) => {
      const runner = await requireRunner(params.id, organizationId);
      return reply.send(await RunnerEventModel.listForRunner(runner.id));
    },
  );

  /**
   * What this user still has to supply before an agent's runner can start.
   * Lets the UI annotate a start button up front rather than failing the click.
   */
  fastify.get(
    "/api/runners/preflight",
    {
      schema: {
        operationId: RouteId.GetRunnerPreflight,
        description:
          "Report credentials the current user must supply before starting a runner for an agent",
        tags: ["Runners"],
        querystring: z.object({ agentId: z.string().uuid() }),
        response: constructResponseSchema(
          z.object({
            canStart: z.boolean(),
            missing: z.array(MissingRunnerCredentialSchema),
            misconfigured: z.array(MissingRunnerCredentialSchema),
          }),
        ),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      assertRunnersEnabled();
      const agent = await requireRunnableAgent(query.agentId, organizationId);
      const preflight = await preflightRunnerCredentials({
        agent,
        organizationId,
        userId: user.id,
      });
      return reply.send({
        canStart:
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
        description: "Start a runner for an agent",
        tags: ["Runners"],
        body: CreateRunnerBodySchema,
        response: constructResponseSchema(RunnerResponseSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      assertRunnersEnabled();
      const agent = await requireRunnableAgent(body.agentId, organizationId);
      const runnerConfig = agent.runnerConfig;

      const namespace = await resolveNamespace({
        organizationId,
        environmentId: agent.environmentId,
      });

      // `deploymentName` is deliberately not set here: the frozen name is
      // derived from the runner's own id, which only exists after the insert.
      // buildRunnerLaunchSpec derives it, and launch() records it.
      const runner = await RunnerModel.create({
        organizationId,
        agentId: agent.id,
        createdByUserId: user.id,
        name: body.name,
        task: body.task ?? null,
        image: runnerConfig?.image ?? config.runners.defaultImage,
        command: runnerConfig?.command ?? null,
        steerMode: runnerConfig?.steerMode ?? "pipe",
        privileged: runnerConfig?.privileged ?? false,
        resources: runnerConfig?.resources ?? null,
        environmentId: agent.environmentId,
        namespace,
        ttlHours: runnerConfig?.ttlHours ?? config.runners.defaultTtlHours,
        idleTimeoutMinutes:
          runnerConfig?.idleTimeoutMinutes ??
          config.runners.defaultIdleTimeoutMinutes,
      });

      try {
        const { spec, virtualApiKeyId } = await buildRunnerLaunchSpec({
          runner,
          agent,
          namespace,
        });
        await RunnerModel.update(runner.id, organizationId, {
          virtualApiKeyId,
        });
        await runnerRuntimeManager.launch({ runner, spec });
      } catch (error) {
        // The row exists but nothing was scheduled; record why so the failure
        // is visible in the timeline instead of only in the response body.
        const reason =
          error instanceof Error ? error.message : "Failed to start the runner";
        await RunnerModel.transition({
          id: runner.id,
          organizationId,
          to: "failed",
          statusReason: reason,
        });
        await RunnerEventModel.append({
          runnerId: runner.id,
          kind: "state_changed",
          message: reason,
          payload: { state: "failed" },
        });
        if (error instanceof RunnerCredentialsRequiredError) {
          // The code is what a client keys the "connect your credentials"
          // step off; it then reads the field list from
          // GET /api/runners/preflight, which returns exactly that shape.
          throw new ApiError(
            409,
            error.message,
            RUNNER_CREDENTIALS_REQUIRED_CODE,
          );
        }
        throw error;
      }

      const started = await RunnerModel.findById(runner.id, organizationId);
      return reply.send(started ?? runner);
    },
  );

  fastify.post(
    "/api/runners/:id/steer",
    {
      schema: {
        operationId: RouteId.SteerRunner,
        description: "Send a message into a running session",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        body: SteerRunnerBodySchema,
        response: constructResponseSchema(z.object({ delivered: z.boolean() })),
      },
    },
    async ({ params, body, organizationId, user }, reply) => {
      const runner = await requireRunner(params.id, organizationId);
      await assertMaySteer({ runner, user, organizationId });
      if (runner.state !== "running") {
        throw new ApiError(
          409,
          `This runner is ${runner.state}, so there is no live session to steer`,
        );
      }

      await runnerRuntimeManager.steer({ runner, message: body.message });
      await RunnerEventModel.append({
        runnerId: runner.id,
        kind: "steer",
        message: body.message,
        actorUserId: user.id,
      });
      return reply.send({ delivered: true });
    },
  );

  fastify.post(
    "/api/runners/:id/stop",
    {
      schema: {
        operationId: RouteId.StopRunner,
        description: "Stop a runner",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(RunnerResponseSchema),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const runner = await requireRunner(params.id, organizationId);
      await assertMaySteer({ runner, user, organizationId });
      await runnerRuntimeManager.stop(runner, "Stopped by request");
      const stopped = await RunnerModel.findById(runner.id, organizationId);
      return reply.send(stopped ?? runner);
    },
  );

  fastify.delete(
    "/api/runners/:id",
    {
      schema: {
        operationId: RouteId.DeleteRunner,
        description: "Delete a runner and its session history",
        tags: ["Runners"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(z.object({ deleted: z.boolean() })),
      },
    },
    async ({ params, organizationId, user }, reply) => {
      const runner = await requireRunner(params.id, organizationId);
      await assertMaySteer({ runner, user, organizationId });
      // Tear the workload down before dropping the row: the row is what tells
      // us the names of the objects to remove.
      await runnerRuntimeManager.teardown(runner).catch((error) => {
        logger.warn(
          { error, runnerId: runner.id },
          "Teardown failed while deleting a runner; removing the row anyway",
        );
      });
      return reply.send({
        deleted: await RunnerModel.delete(runner.id, organizationId),
      });
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

async function requireRunnableAgent(agentId: string, organizationId: string) {
  const agent = await AgentModel.findById(agentId);
  // findById is not organization-scoped, so the tenant check is explicit.
  if (!agent || agent.organizationId !== organizationId) {
    throw new ApiError(404, "Agent not found");
  }
  if (!agent.runnerConfig) {
    throw new ApiError(
      400,
      "This agent has no runner configuration, so it cannot be started as a runner",
    );
  }
  return agent;
}

/**
 * Attaching to or steering a runner reaches a shell running under the
 * creator's own credentials, so it is deliberately narrower than the
 * `runner:update` permission that gets you to this point: the creator, or an
 * administrator who can already act across the organization's runners.
 */
async function assertMaySteer(params: {
  runner: Runner;
  user: User;
  organizationId: string;
}): Promise<void> {
  if (params.runner.createdByUserId === params.user.id) {
    return;
  }
  const isAdmin = await userHasPermission(
    params.user.id,
    params.organizationId,
    "runner",
    "admin",
  );
  if (!isAdmin) {
    throw new ApiError(
      403,
      "Only the person who started this runner can steer or stop it",
    );
  }
}

/**
 * Namespace the runner's pod lands in: the environment's own when the agent is
 * bound to one, otherwise the organization's default. Never creates a
 * namespace — an unknown one is an operator's decision to make.
 */
async function resolveNamespace(params: {
  organizationId: string;
  environmentId: string | null;
}): Promise<string> {
  if (params.environmentId) {
    const environment = await EnvironmentModel.findByIdForOrganization(
      params.environmentId,
      params.organizationId,
    );
    if (environment?.namespace) {
      return environment.namespace;
    }
  }
  const organization = await OrganizationModel.getById(params.organizationId);
  return (
    organization?.defaultEnvironmentNamespace ??
    config.orchestrator.kubernetes.namespace
  );
}
