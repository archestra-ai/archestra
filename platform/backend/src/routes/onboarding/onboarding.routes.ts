import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  InteractionModel,
  McpToolCallModel,
  OnboardingSurveySubmissionModel,
  UserOnboardingStepModel,
} from "@/models";
import {
  constructResponseSchema,
  type SubmitOnboardingSurvey,
  SubmitOnboardingSurveySchema,
} from "@/types";

/**
 * Per-user onboarding progress. Every authenticated user reads and writes only
 * their own progress (scoped to `request.user.id`), which drives the gentle
 * red-dot onboarding in the sidebar. An empty set means every dot is still
 * shown, so new users see the full onboarding.
 */
const onboardingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/onboarding/steps",
    {
      schema: {
        operationId: RouteId.GetOnboardingSteps,
        description:
          "List the onboarding step keys the current user has completed.",
        tags: ["Onboarding"],
        response: constructResponseSchema(
          z.object({ completedKeys: z.array(z.string()) }),
        ),
      },
    },
    async ({ user }) => {
      const completedKeys = await UserOnboardingStepModel.listCompletedKeys({
        userId: user.id,
      });
      return { completedKeys };
    },
  );

  fastify.post(
    "/api/onboarding/steps/complete",
    {
      schema: {
        operationId: RouteId.CompleteOnboardingStep,
        description:
          "Mark an onboarding step complete for the current user. Idempotent.",
        tags: ["Onboarding"],
        body: z.object({ stepKey: z.string().min(1).max(256) }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ body: { stepKey }, user }) => {
      await UserOnboardingStepModel.markCompleted({ userId: user.id, stepKey });
      return { ok: true as const };
    },
  );

  /**
   * Whether the one-time onboarding survey should still be collected for this
   * org. True only when it hasn't been answered, the system is still empty
   * (no LLM or MCP activity yet), and this is not a licensed enterprise
   * deployment. Note we gate on the genuine enterprise license flag, not
   * `enterpriseTier.isCoreActive()` — the latter is also true for the free
   * small-team tier, which is exactly the audience the survey targets. The
   * frontend additionally shows it to admins only.
   */
  fastify.get(
    "/api/onboarding/survey/status",
    {
      schema: {
        operationId: RouteId.GetOnboardingSurveyStatus,
        description:
          "Whether the one-time onboarding survey still needs to be collected for this organization.",
        tags: ["Onboarding"],
        response: constructResponseSchema(
          z.object({ needsSubmission: z.boolean() }),
        ),
      },
    },
    async ({ organizationId }) => {
      const alreadyAnswered =
        await OnboardingSurveySubmissionModel.hasSubmitted(organizationId);
      if (alreadyAnswered || config.enterpriseFeatures.core) {
        return { needsSubmission: false };
      }
      const [interactions, mcpToolCalls] = await Promise.all([
        InteractionModel.getCount(),
        McpToolCallModel.getCount(),
      ]);
      const systemIsEmpty = interactions === 0 && mcpToolCalls === 0;
      return { needsSubmission: systemIsEmpty };
    },
  );

  fastify.post(
    "/api/onboarding/survey",
    {
      schema: {
        operationId: RouteId.SubmitOnboardingSurvey,
        description:
          "Submit the one-time onboarding survey for this organization. Idempotent — the first submission wins.",
        tags: ["Onboarding"],
        body: SubmitOnboardingSurveySchema,
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ body, organizationId, user }) => {
      // Forward the answers to archestra-website for collection, then record a
      // local marker so the org is never surveyed again. Forwarding is
      // best-effort: a failure is logged but still marks the survey done, so a
      // transient outage doesn't re-nag the admin.
      await forwardSurveyToWebsite(body);
      await OnboardingSurveySubmissionModel.record({
        organizationId,
        submittedByUserId: user.id,
      });
      return { ok: true as const };
    },
  );
};

/** Best-effort POST of the survey answers to the archestra-website API. */
async function forwardSurveyToWebsite(
  answers: SubmitOnboardingSurvey,
): Promise<void> {
  const endpoint = config.onboarding.surveyEndpoint;
  if (!endpoint) return;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...answers,
        archestraVersion: config.api.version,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Failed to forward onboarding survey to archestra-website",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "Error forwarding onboarding survey to archestra-website",
    );
  }
}

export default onboardingRoutes;
