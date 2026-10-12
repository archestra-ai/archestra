import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getOpenAppaPolicyTestRuns,
  getOpenAppaPolicyTests,
  inspectOpenAppaPolicyTests,
  previewOpenAppaPolicyTest,
  runOpenAppaPolicyTests,
  updateOpenAppaPolicyTests,
} from "@/services/openappa-policy-tests";
import { constructResponseSchema } from "@/types";
import {
  InspectPolicyTestsSchema,
  PolicyTestCollectionSchema,
  PolicyTestInspectionSchema,
  PolicyTestPreviewSchema,
  PolicyTestRunSchema,
  PreviewPolicyTestSchema,
  RunPolicyTestsSchema,
  UpdatePolicyTestsSchema,
} from "@/types/openappa-policy-tests";

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
      const run = await runOpenAppaPolicyTests({
        ...request.body,
        organizationId: request.organizationId,
        userId: request.user.id,
      });
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
        response: constructResponseSchema(PolicyTestPreviewSchema),
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
