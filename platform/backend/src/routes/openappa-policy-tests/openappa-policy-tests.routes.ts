import {
  type OpenAppaValidationProgressMessage,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import logger from "@/logging";
import {
  getOpenAppaPolicyTestRuns,
  getOpenAppaPolicyTests,
  inspectOpenAppaPolicyTests,
  type PolicyTestProgressEvent,
  previewOpenAppaPolicyTest,
  runOpenAppaPolicyTests,
  updateOpenAppaPolicyTests,
} from "@/services/openappa-policy-tests";
import { ApiError, constructResponseSchema } from "@/types";
import {
  InspectPolicyTestsSchema,
  PolicyTestCollectionSchema,
  PolicyTestInspectionSchema,
  PolicyTestRunResultSchema,
  PolicyTestRunSchema,
  PreviewPolicyTestSchema,
  RunPolicyTestsSchema,
  UpdatePolicyTestsSchema,
} from "@/types/openappa-policy-tests";
import websocketService from "@/websocket";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/api/openappa/policy-tests/inspect",
    {
      schema: {
        operationId: RouteId.InspectOpenAppaPolicyTests,
        tags: ["OpenAPPA"],
        body: InspectPolicyTestsSchema,
        response: constructResponseSchema(PolicyTestInspectionSchema),
      },
    },
    async (request, reply) =>
      reply.send(await inspectOpenAppaPolicyTests(request.body.files)),
  );
  app.get(
    "/api/openappa/policy-tests",
    {
      schema: {
        operationId: RouteId.GetOpenAppaPolicyTests,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(PolicyTestCollectionSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await getOpenAppaPolicyTests(request.organizationId, request.user.id),
      ),
  );
  app.put(
    "/api/openappa/policy-tests",
    {
      schema: {
        operationId: RouteId.UpdateOpenAppaPolicyTests,
        tags: ["OpenAPPA"],
        body: UpdatePolicyTestsSchema,
        response: constructResponseSchema(PolicyTestCollectionSchema),
      },
    },
    async (request, reply) => {
      const saved = await updateOpenAppaPolicyTests({
        ...request.body,
        organizationId: request.organizationId,
      });
      request.auditAfter = {
        version: saved.version,
        fileCount: saved.files.length,
      };
      return reply.send(saved);
    },
  );
  app.post(
    "/api/openappa/policy-tests/run",
    {
      schema: {
        operationId: RouteId.RunOpenAppaPolicyTests,
        tags: ["OpenAPPA"],
        body: RunPolicyTestsSchema,
        response: constructResponseSchema(PolicyTestRunSchema),
      },
    },
    async (request, reply) => {
      const { progressToken, ...body } = request.body;
      const progress = progressToken
        ? new ValidationProgressSender({
            token: progressToken,
            userId: request.user.id,
            organizationId: request.organizationId,
          })
        : null;
      progress?.send({
        phase: "started",
        paths: body.files.map((file) => file.path),
      });
      let run: Awaited<ReturnType<typeof runOpenAppaPolicyTests>>;
      try {
        run = await runOpenAppaPolicyTests({
          ...body,
          organizationId: request.organizationId,
          userId: request.user.id,
          onProgress: progress?.onFileProgress,
        });
      } catch (error) {
        progress?.send({
          phase: "finished",
          runId: null,
          error:
            error instanceof ApiError
              ? error.message
              : "The validation run failed",
        });
        throw error;
      }
      progress?.send({ phase: "finished", runId: run.id });
      request.auditAfter = {
        runId: run.id,
        fileCount: run.files.length,
        policyRevision: run.policyRevision,
      };
      return reply.send(run);
    },
  );
  app.get(
    "/api/openappa/policy-tests/runs",
    {
      schema: {
        operationId: RouteId.GetOpenAppaPolicyTestRuns,
        tags: ["OpenAPPA"],
        response: constructResponseSchema(z.array(PolicyTestRunSchema)),
      },
    },
    async (request, reply) =>
      reply.send(await getOpenAppaPolicyTestRuns(request.organizationId)),
  );
  app.post(
    "/api/openappa/policy-tests/preview",
    {
      schema: {
        operationId: RouteId.PreviewOpenAppaPolicyTest,
        tags: ["OpenAPPA"],
        body: PreviewPolicyTestSchema,
        response: constructResponseSchema(PolicyTestRunResultSchema),
      },
    },
    async (request, reply) =>
      reply.send(
        await previewOpenAppaPolicyTest({
          ...request.body,
          organizationId: request.organizationId,
          userId: request.user.id,
        }),
      ),
  );
};
export default routes;

// =============================================================================
// Internal
// =============================================================================

type ProgressPayload = OpenAppaValidationProgressMessage["payload"];
type UntokenedProgressPayload = ProgressPayload extends infer Payload
  ? Payload extends ProgressPayload
    ? Omit<Payload, "token">
    : never
  : never;

/**
 * Streams one manual run's progress to the sockets of the user who started
 * it. Progress only observes the run: a delivery failure is logged, never
 * raised, and nothing waits on it.
 */
class ValidationProgressSender {
  constructor(
    private readonly target: {
      token: string;
      userId: string;
      organizationId: string;
    },
  ) {}

  readonly onFileProgress = (event: PolicyTestProgressEvent) => {
    if (event.phase === "file_started") {
      this.send({ phase: "file_started", path: event.path });
      return;
    }
    const { file } = event;
    this.send({
      phase: "file_finished",
      path: file.path,
      status: file.status,
      assertionCount: file.assertionCount,
      durationMs: file.durationMs ?? 0,
      error: file.error,
      steps: file.steps,
    });
  };

  send(payload: UntokenedProgressPayload) {
    const { token, userId, organizationId } = this.target;
    try {
      websocketService.sendOpenAppaValidationProgress({
        userId,
        organizationId,
        payload: { ...payload, token },
      });
    } catch (error) {
      logger.warn(
        { err: error, organizationId },
        "OpenAPPA could not send policy validation progress",
      );
    }
  }
}
