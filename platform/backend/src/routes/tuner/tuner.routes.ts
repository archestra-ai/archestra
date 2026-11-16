import {
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { TunerSuggestionModel } from "@/models";
import {
  applyPolicySuggestion,
  refreshPolicySuggestion,
} from "@/services/tuners/apply";
import {
  configureTuner,
  listTuners,
  runTunerNow,
} from "@/services/tuners/manage";
import {
  ApiError,
  constructResponseSchema,
  ErrorResponsesSchema,
  UuidIdSchema,
} from "@/types";
import { ScheduleTriggerRunResponseSchema } from "@/types/schedule-trigger";
import { TunerKindSchema } from "@/types/tuner";
import {
  CloseTunerSuggestionRequestSchema,
  ConfigureTunerRequestSchema,
  ListTunerSuggestionsQuerySchema,
  RejectTunerSuggestionRequestSchema,
  SelectTunerSuggestionSchema,
  TunerSummarySchema,
} from "@/types/tuner-suggestion";

const KindParamsSchema = z.object({ kind: TunerKindSchema });
const IdParamsSchema = z.object({ id: UuidIdSchema });

/** Tuners (scheduled built-in agents) and their suggestion inbox. */
const tunerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/tuners",
    {
      schema: {
        operationId: RouteId.ListTuners,
        description:
          "List the tuners, whether this deployment can run each, its schedule, and its latest run.",
        tags: ["Tuners"],
        response: constructResponseSchema(z.array(TunerSummarySchema)),
      },
    },
    async ({ organizationId }, reply) => {
      assertTunersEnabled();
      return reply.send(await listTuners(organizationId));
    },
  );

  fastify.put(
    "/api/tuners/:kind",
    {
      schema: {
        operationId: RouteId.ConfigureTuner,
        description:
          "Enable, disable or reschedule a tuner. The caller becomes the user the tuner runs as when enabling it.",
        tags: ["Tuners"],
        params: KindParamsSchema,
        body: ConfigureTunerRequestSchema,
        response: constructResponseSchema(z.array(TunerSummarySchema)),
      },
    },
    async ({ organizationId, user, params, body }, reply) => {
      assertTunersEnabled();
      await configureTuner({
        organizationId,
        userId: user.id,
        kind: params.kind,
        request: body,
      });
      return reply.send(await listTuners(organizationId));
    },
  );

  fastify.post(
    "/api/tuners/:kind/run",
    {
      schema: {
        operationId: RouteId.RunTuner,
        description: "Queue a run of a tuner now. Returns 202 with the run.",
        tags: ["Tuners"],
        params: KindParamsSchema,
        response: {
          202: ScheduleTriggerRunResponseSchema,
          ...ErrorResponsesSchema,
        },
      },
    },
    async ({ organizationId, user, params }, reply) => {
      assertTunersEnabled();
      return reply.status(202).send(
        await runTunerNow({
          organizationId,
          userId: user.id,
          kind: params.kind,
        }),
      );
    },
  );

  fastify.get(
    "/api/tuner-suggestions",
    {
      schema: {
        operationId: RouteId.ListTunerSuggestions,
        description: "List tuner suggestions, newest first.",
        tags: ["Tuners"],
        querystring: PaginationQuerySchema.merge(
          ListTunerSuggestionsQuerySchema,
        ),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectTunerSuggestionSchema),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      assertTunersEnabled();
      return reply.send(
        await TunerSuggestionModel.list({
          organizationId,
          tunerKind: query.kind,
          statuses: query.status,
          pagination: { limit: query.limit, offset: query.offset },
        }),
      );
    },
  );

  fastify.post(
    "/api/tuner-suggestions/:id/done",
    {
      schema: {
        operationId: RouteId.MarkTunerSuggestionDone,
        description:
          "Mark an open suggestion as handled. The tuner stays quiet about it for 14 days unless it gets worse.",
        tags: ["Tuners"],
        params: IdParamsSchema,
        body: CloseTunerSuggestionRequestSchema,
        response: constructResponseSchema(SelectTunerSuggestionSchema),
      },
    },
    async ({ organizationId, user, params, body }, reply) => {
      assertTunersEnabled();
      return reply.send(
        await closeOrThrow({
          id: params.id,
          organizationId,
          userId: user.id,
          status: "done",
          comment: body.comment ?? null,
        }),
      );
    },
  );

  fastify.post(
    "/api/tuner-suggestions/:id/reject",
    {
      schema: {
        operationId: RouteId.RejectTunerSuggestion,
        description:
          "Reject an open suggestion with a reason the tuner reads next time. It stays quiet about it for 14 days unless it gets worse.",
        tags: ["Tuners"],
        params: IdParamsSchema,
        body: RejectTunerSuggestionRequestSchema,
        response: constructResponseSchema(SelectTunerSuggestionSchema),
      },
    },
    async ({ organizationId, user, params, body }, reply) => {
      assertTunersEnabled();
      return reply.send(
        await closeOrThrow({
          id: params.id,
          organizationId,
          userId: user.id,
          status: "rejected",
          comment: body.comment,
        }),
      );
    },
  );

  fastify.post(
    "/api/tuner-suggestions/:id/apply",
    {
      schema: {
        operationId: RouteId.ApplyTunerSuggestion,
        description:
          "Apply an open policy-change suggestion as the caller: a locally managed policy saves a new revision; with Git sync a change request is opened. 409 when the policy or the suggestion changed since.",
        tags: ["Tuners"],
        params: IdParamsSchema,
        response: constructResponseSchema(SelectTunerSuggestionSchema),
      },
    },
    async ({ organizationId, user, params }, reply) => {
      assertTunersEnabled();
      return reply.send(
        await applyPolicySuggestion({
          id: params.id,
          organizationId,
          userId: user.id,
        }),
      );
    },
  );

  fastify.post(
    "/api/tuner-suggestions/:id/refresh",
    {
      schema: {
        operationId: RouteId.RefreshTunerSuggestion,
        description:
          "Check a published policy change's change request: once merged and applied by Git sync the suggestion becomes effective; closed unmerged, it is open again.",
        tags: ["Tuners"],
        params: IdParamsSchema,
        response: constructResponseSchema(SelectTunerSuggestionSchema),
      },
    },
    async ({ organizationId, user, params }, reply) => {
      assertTunersEnabled();
      return reply.send(
        await refreshPolicySuggestion({
          id: params.id,
          organizationId,
          userId: user.id,
        }),
      );
    },
  );
};

export default tunerRoutes;

function assertTunersEnabled() {
  if (!config.tuners.enabled) throw new ApiError(404, "Tuners are disabled");
}

async function closeOrThrow(
  params: Parameters<typeof TunerSuggestionModel.close>[0],
) {
  const closed = await TunerSuggestionModel.close(params);
  if (closed) return closed;
  const exists = await TunerSuggestionModel.findById(params);
  throw exists
    ? new ApiError(409, "The suggestion is no longer open")
    : new ApiError(404, "Suggestion not found");
}
