import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  EvalCaseModel,
  EvalRunModel,
  EvalRunResultModel,
  EvalSuiteModel,
  InteractionModel,
} from "@/models";
import { MAX_CASES_PER_SUITE } from "@/models/eval-case";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  UuidIdSchema,
} from "@/types";
import {
  EvalCaseAssertionsSchema,
  EvalCaseMessagesSchema,
  EvalRunStatusSchema,
  SelectEvalCaseSchema,
  SelectEvalRunResultSchema,
  SelectEvalRunSchema,
  SelectEvalSuiteSchema,
} from "@/types/eval";
import { BulkDeleteBodySchema, BulkOutcomeSchema, runBulk } from "./bulk-route";

const EvalSuiteWithCaseCountSchema = SelectEvalSuiteSchema.extend({
  caseCount: z.number(),
});

const CreateEvalSuiteBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const UpdateEvalSuiteBodySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

const CaseBodyFieldsSchema = z.object({
  name: z.string().min(1).max(200),
  messages: EvalCaseMessagesSchema,
  assertions: EvalCaseAssertionsSchema,
});

const UpdateEvalCaseBodySchema = CaseBodyFieldsSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: "At least one field must be provided" },
);

const MAX_AGENTS_PER_RUN = 10;

const CreateEvalRunBodySchema = z.object({
  /** One run is created per agent; several agents make a comparison group. */
  agentIds: z.array(UuidIdSchema).min(1).max(MAX_AGENTS_PER_RUN),
  /** Optional label, e.g. a CI build identifier. */
  name: z.string().min(1).max(200).optional(),
});

const EvalRunDetailSchema = SelectEvalRunSchema.extend({
  // Cost is computed at read time from the run's LLM proxy sessions and uses
  // the same billed/subscription split as the sessions UI. Proxy persistence
  // lags execution slightly, so cost may settle shortly after completion.
  billedCost: z.number(),
  subscriptionCost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

const evalRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // === Suites ===

  fastify.get(
    "/api/eval-suites",
    {
      schema: {
        operationId: RouteId.GetEvalSuites,
        description: "List eval suites",
        tags: ["Evals"],
        querystring: PaginationQuerySchema.extend({
          name: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(EvalSuiteWithCaseCountSchema),
        ),
      },
    },
    async ({ query: { limit, offset, name }, organizationId }, reply) => {
      const [data, total] = await Promise.all([
        EvalSuiteModel.listByOrganization({
          organizationId,
          limit,
          offset,
          name,
        }),
        EvalSuiteModel.countByOrganization({ organizationId, name }),
      ]);
      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/eval-suites",
    {
      schema: {
        operationId: RouteId.CreateEvalSuite,
        description: "Create an eval suite",
        tags: ["Evals"],
        body: CreateEvalSuiteBodySchema,
        response: constructResponseSchema(SelectEvalSuiteSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const suite = await EvalSuiteModel.create({
        organizationId,
        name: body.name,
        description: body.description ?? null,
        createdBy: user.id,
      });
      return reply.send(suite);
    },
  );

  fastify.get(
    "/api/eval-suites/:id",
    {
      schema: {
        operationId: RouteId.GetEvalSuite,
        description: "Get an eval suite",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectEvalSuiteSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const suite = await EvalSuiteModel.findById(id, organizationId);
      if (!suite) {
        throw new ApiError(404, "Eval suite not found");
      }
      return reply.send(suite);
    },
  );

  fastify.put(
    "/api/eval-suites/:id",
    {
      schema: {
        operationId: RouteId.UpdateEvalSuite,
        description: "Update an eval suite",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateEvalSuiteBodySchema,
        response: constructResponseSchema(SelectEvalSuiteSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const suite = await EvalSuiteModel.update({
        id,
        organizationId,
        updates: body,
      });
      if (!suite) {
        throw new ApiError(404, "Eval suite not found");
      }
      return reply.send(suite);
    },
  );

  fastify.delete(
    "/api/eval-suites/:id",
    {
      schema: {
        operationId: RouteId.DeleteEvalSuite,
        description:
          "Delete an eval suite (soft delete; run history is preserved)",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const deleted = await EvalSuiteModel.softDelete(id, organizationId);
      if (!deleted) {
        throw new ApiError(404, "Eval suite not found");
      }
      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/eval-suites/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteEvalSuites,
        description:
          "Soft-delete several eval suites in one request. An id the caller " +
          "cannot see is reported in `failed` and the rest of the batch " +
          "still applies.",
        tags: ["Evals"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId } = request;
      const snapshot = async (ids: string[]) => {
        const suites = await EvalSuiteModel.listByIds(ids, organizationId);
        return {
          evalSuites: suites
            .map(({ id, name }) => ({ id, name }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "eval suites bulk delete",
        notFoundMessage: "Eval suite not found",
        unexpectedMessage: "Could not delete this eval suite",
        load: async (ids) =>
          new Map(
            (await EvalSuiteModel.listByIds(ids, organizationId)).map(
              (suite) => [suite.id, suite] as const,
            ),
          ),
        describe: (suite) => suite.name,
        applyEach: async (suite) => {
          const deleted = await EvalSuiteModel.softDelete(
            suite.id,
            organizationId,
          );
          if (!deleted) {
            throw new ApiError(404, "Eval suite not found");
          }
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );

  // === Cases ===

  fastify.get(
    "/api/eval-suites/:id/cases",
    {
      schema: {
        operationId: RouteId.GetEvalSuiteCases,
        description: "List an eval suite's cases in position order",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(z.array(SelectEvalCaseSchema)),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const suite = await EvalSuiteModel.findById(id, organizationId);
      if (!suite) {
        throw new ApiError(404, "Eval suite not found");
      }
      return reply.send(await EvalCaseModel.listBySuite(id));
    },
  );

  fastify.post(
    "/api/eval-suites/:id/cases",
    {
      schema: {
        operationId: RouteId.CreateEvalSuiteCase,
        description: `Add a case to an eval suite (max ${MAX_CASES_PER_SUITE} cases per suite)`,
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        body: CaseBodyFieldsSchema,
        response: constructResponseSchema(SelectEvalCaseSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const evalCase = await EvalCaseModel.create({
        organizationId,
        insert: { suiteId: id, ...body },
      });
      return reply.send(evalCase);
    },
  );

  fastify.put(
    "/api/eval-cases/:id",
    {
      schema: {
        operationId: RouteId.UpdateEvalCase,
        description: "Update an eval case",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        body: UpdateEvalCaseBodySchema,
        response: constructResponseSchema(SelectEvalCaseSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        body,
        organizationId,
      } = request;
      const evalCase = await EvalCaseModel.update({
        id,
        organizationId,
        updates: body,
      });
      if (!evalCase) {
        throw new ApiError(404, "Eval case not found");
      }
      // Audited as evalSuite.updated: point the record at the suite (the path
      // param is the case) and snapshot the suite post-update.
      request.auditResourceId = { value: evalCase.suiteId };
      request.auditAfter = await EvalSuiteModel.findByIdForAudit(
        evalCase.suiteId,
        organizationId,
      );
      return reply.send(evalCase);
    },
  );

  fastify.delete(
    "/api/eval-cases/:id",
    {
      schema: {
        operationId: RouteId.DeleteEvalCase,
        description: "Delete an eval case",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        organizationId,
      } = request;
      const evalCase = await EvalCaseModel.findById(id, organizationId);
      if (!evalCase) {
        throw new ApiError(404, "Eval case not found");
      }
      await EvalCaseModel.delete({ id, organizationId });
      // The case row is gone, so the registry's fetchById cannot produce the
      // after-snapshot; supply the suite's post-delete state explicitly.
      request.auditResourceId = { value: evalCase.suiteId };
      request.auditAfter = await EvalSuiteModel.findByIdForAudit(
        evalCase.suiteId,
        organizationId,
      );
      return reply.send({ success: true });
    },
  );

  // === Runs ===

  fastify.post(
    "/api/eval-suites/:id/runs",
    {
      schema: {
        operationId: RouteId.CreateEvalRun,
        description:
          "Run an eval suite against one or more agents. One run is created per agent (a shared group id links them for comparison); each snapshots the suite's current cases and executes asynchronously.",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        body: CreateEvalRunBodySchema,
        response: constructResponseSchema(z.array(SelectEvalRunSchema)),
      },
    },
    async (request, reply) => {
      const {
        params: { id },
        body,
        user,
        organizationId,
      } = request;
      const suite = await EvalSuiteModel.findById(id, organizationId);
      if (!suite) {
        throw new ApiError(404, "Eval suite not found");
      }

      // Validate every agent before creating anything: a bad id fails the
      // whole request rather than starting a partial comparison group.
      const agentIds = [...new Set(body.agentIds)];
      const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
        userId: user.id,
        organizationId,
      });
      const agents = [];
      for (const agentId of agentIds) {
        const agent = await AgentModel.findById(agentId);
        if (!agent || agent.organizationId !== organizationId) {
          throw new ApiError(404, "Agent not found");
        }
        if (agent.agentType !== "agent") {
          throw new ApiError(422, "Evals can only run against internal agents");
        }
        // Same access rule as everywhere agents are executed: an agent-type
        // admin bypasses team scoping, everyone else needs personal/team access.
        const hasAgentAccess = await AgentTeamModel.userHasAgentAccess(
          user.id,
          agent.id,
          isAgentAdmin,
        );
        if (!hasAgentAccess) {
          throw new ApiError(403, "You do not have access to this agent");
        }
        agents.push(agent);
      }

      const cases = await EvalCaseModel.listBySuite(suite.id);
      if (cases.length === 0) {
        throw new ApiError(422, "Eval suite has no cases");
      }

      const groupId = crypto.randomUUID();
      const runs = [];
      for (const agent of agents) {
        runs.push(
          await EvalRunModel.createWithResults({
            organizationId,
            suiteId: suite.id,
            agentId: agent.id,
            groupId,
            agentNameSnapshot: agent.name,
            modelSnapshot: agent.llmModel ?? null,
            name: body.name ?? null,
            createdBy: user.id,
            cases,
          }),
        );
      }

      let enqueued = 0;
      for (const run of runs) {
        try {
          await taskQueueService.enqueue({
            taskType: "eval_run_execute",
            payload: { runId: run.id },
          });
          enqueued += 1;
        } catch (error) {
          // Compensate: a run nobody will ever execute must not sit pending.
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(
            { runId: run.id, error: message },
            "[Evals] Failed to enqueue eval run",
          );
          await EvalRunModel.markFailed(
            run.id,
            "Failed to enqueue the run for execution",
          );
          await EvalRunResultModel.cancelPendingByRun(run.id);
          const counts = await EvalRunResultModel.countByStatus(run.id);
          await EvalRunModel.updateCounts(run.id, {
            passedCases: counts.passed,
            failedCases: counts.failed,
            erroredCases: counts.error,
            canceledCases: counts.canceled,
          });
        }
      }
      if (enqueued === 0) {
        throw new ApiError(500, "Failed to enqueue the eval run");
      }

      // The resource is the run group, not the suite named in the path.
      request.auditResourceId = { value: groupId };
      request.auditAfter = {
        groupId,
        suiteId: suite.id,
        suiteName: suite.name,
        agents: agents.map(({ id, name }) => ({ id, name })),
        runIds: runs.map((run) => run.id),
        name: body.name ?? null,
        totalCases: cases.length,
      };
      return reply.send(runs);
    },
  );

  fastify.get(
    "/api/eval-runs",
    {
      schema: {
        operationId: RouteId.GetEvalRuns,
        description: "List eval runs",
        tags: ["Evals"],
        querystring: PaginationQuerySchema.extend({
          suiteId: UuidIdSchema.optional(),
          agentId: UuidIdSchema.optional(),
          status: EvalRunStatusSchema.optional(),
          groupId: UuidIdSchema.optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectEvalRunSchema),
        ),
      },
    },
    async (
      {
        query: { limit, offset, suiteId, agentId, status, groupId },
        organizationId,
      },
      reply,
    ) => {
      const filters = { organizationId, suiteId, agentId, status, groupId };
      const [data, total] = await Promise.all([
        EvalRunModel.listByOrganization({ ...filters, limit, offset }),
        EvalRunModel.countByOrganization(filters),
      ]);
      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.get(
    "/api/eval-runs/:id",
    {
      schema: {
        operationId: RouteId.GetEvalRun,
        description:
          "Get an eval run with cost and token aggregates. Cost is computed from the run's LLM sessions and may settle shortly after completion.",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(EvalRunDetailSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const run = await EvalRunModel.findById(id, organizationId);
      if (!run) {
        throw new ApiError(404, "Eval run not found");
      }
      const sessionIds = await EvalRunResultModel.getSessionIds(run.id);
      const [cost, tokens] = await Promise.all([
        InteractionModel.getCostBySessionIds({ organizationId, sessionIds }),
        EvalRunResultModel.sumTokensByRun(run.id),
      ]);
      return reply.send({ ...run, ...cost, ...tokens });
    },
  );

  fastify.get(
    "/api/eval-runs/:id/results",
    {
      schema: {
        operationId: RouteId.GetEvalRunResults,
        description: "List an eval run's per-case results in position order",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        querystring: PaginationQuerySchema,
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectEvalRunResultSchema),
        ),
      },
    },
    async (
      { params: { id }, query: { limit, offset }, organizationId },
      reply,
    ) => {
      const run = await EvalRunModel.findById(id, organizationId);
      if (!run) {
        throw new ApiError(404, "Eval run not found");
      }
      const [data, total] = await Promise.all([
        EvalRunResultModel.listByRun({ runId: run.id, limit, offset }),
        EvalRunResultModel.countByRun(run.id),
      ]);
      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/eval-runs/:id/cancel",
    {
      schema: {
        operationId: RouteId.CancelEvalRun,
        description: "Cancel a pending or running eval run",
        tags: ["Evals"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectEvalRunSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const existing = await EvalRunModel.findById(id, organizationId);
      if (!existing) {
        throw new ApiError(404, "Eval run not found");
      }
      const canceled = await EvalRunModel.cancel(id, organizationId);
      if (!canceled) {
        throw new ApiError(409, "Eval run has already finished");
      }
      // Close out never-started cases immediately so the results view settles;
      // the worker's watchdog aborts any in-flight case and re-syncs counts.
      await EvalRunResultModel.cancelPendingByRun(id);
      const counts = await EvalRunResultModel.countByStatus(id);
      await EvalRunModel.updateCounts(id, {
        passedCases: counts.passed,
        failedCases: counts.failed,
        erroredCases: counts.error,
        canceledCases: counts.canceled,
      });
      const run = await EvalRunModel.findById(id, organizationId);
      return reply.send(run ?? canceled);
    },
  );
};

export default evalRoutes;
