import { RouteId, WEBSITE_URL } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import {
  InteractionModel,
  McpServerModel,
  McpToolCallModel,
  OrganizationModel,
  UserOnboardingSeenItemModel,
} from "@/models";
import { constructResponseSchema } from "@/types";

const SeenNavItemsResponseSchema = z.object({
  items: z.array(z.string()),
});

const SubmitOnboardingSurveyBodySchema = z.object({
  role: z.string().min(1).max(200),
  workEnvironment: z.string().min(1).max(200),
  referralSource: z.string().min(1).max(200),
  workEmail: z.string().email().max(320).optional(),
});

const onboardingRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/onboarding/seen-nav-items",
    {
      schema: {
        operationId: RouteId.GetOnboardingSeenNavItems,
        description:
          "Get the onboarding nav items (red-dot nudges) the current user has already visited",
        tags: ["Onboarding"],
        response: constructResponseSchema(SeenNavItemsResponseSchema),
      },
    },
    async ({ user }, reply) => {
      const items = await UserOnboardingSeenItemModel.getSeenItems(user.id);
      return reply.send({ items });
    },
  );

  fastify.post(
    "/api/onboarding/seen-nav-items",
    {
      schema: {
        operationId: RouteId.MarkOnboardingNavItemsSeen,
        description:
          "Mark onboarding nav items (red-dot nudges) as visited for the current user; idempotent",
        tags: ["Onboarding"],
        body: z.object({
          items: z.array(z.string().min(1).max(128)).min(1).max(50),
        }),
        response: constructResponseSchema(SeenNavItemsResponseSchema),
      },
    },
    async ({ body, user }, reply) => {
      await UserOnboardingSeenItemModel.markSeen({
        userId: user.id,
        items: body.items,
      });
      const items = await UserOnboardingSeenItemModel.getSeenItems(user.id);
      return reply.send({ items });
    },
  );

  fastify.get(
    "/api/onboarding/survey-eligibility",
    {
      schema: {
        operationId: RouteId.GetOnboardingSurveyEligibility,
        description:
          "Whether the first-login onboarding survey should be shown: unlicensed instance, no LLM/MCP activity yet, not already submitted for the organization",
        tags: ["Onboarding"],
        response: constructResponseSchema(z.object({ eligible: z.boolean() })),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send({
        eligible: await isSurveyEligible(organizationId),
      });
    },
  );

  fastify.post(
    "/api/onboarding/survey",
    {
      schema: {
        operationId: RouteId.SubmitOnboardingSurvey,
        description:
          "Submit the first-login onboarding survey; forwarded to the website and recorded once per organization",
        tags: ["Onboarding"],
        body: SubmitOnboardingSurveyBodySchema,
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Atomically claim the survey for this org; only the caller that flips
      // the flag forwards, so two admins submitting concurrently can't create a
      // duplicate website record. Best-effort forward: the flag is set either
      // way, so an unreachable website (airgapped deployments) never re-nags.
      const isFirstSubmission =
        await OrganizationModel.markOnboardingSurveyCompleted(organizationId);
      if (isFirstSubmission) {
        await forwardSurveyToWebsite(body);
      }
      return reply.send({ ok: true });
    },
  );

  fastify.get(
    "/api/onboarding/feedback-popup-activation",
    {
      schema: {
        operationId: RouteId.GetFeedbackPopupActivation,
        description:
          "When the instance got activated for the feedback pop-up: an MCP server connected AND a successful tool call routed. Null until both happened, and always null on enterprise-licensed instances.",
        tags: ["Onboarding"],
        response: constructResponseSchema(
          z.object({ activatedAt: z.string().datetime().nullable() }),
        ),
      },
    },
    async (_request, reply) => {
      // Never nudge licensed customers for feedback (raw env flag, same gate
      // as the first-login survey), and respect the analytics opt-out — a
      // deployment that disabled phone-home shouldn't be asked to phone home.
      if (config.enterpriseFeatures.core || !config.analytics.enabled) {
        return reply.send({ activatedAt: null });
      }
      const [firstServerAt, firstSuccessfulCallAt] = await Promise.all([
        McpServerModel.getFirstCreatedAt(),
        McpToolCallModel.getFirstSuccessfulToolCallAt(),
      ]);
      // Activation is complete only once both signals exist; it happened when
      // the later of the two did.
      const activatedAt =
        firstServerAt && firstSuccessfulCallAt
          ? new Date(
              Math.max(
                firstServerAt.getTime(),
                firstSuccessfulCallAt.getTime(),
              ),
            )
          : null;
      return reply.send({ activatedAt: activatedAt?.toISOString() ?? null });
    },
  );
};

export default onboardingRoutes;

// === Internal helpers ===

async function isSurveyEligible(organizationId: string): Promise<boolean> {
  // Never on licensed instances. The raw env flag, deliberately not the
  // effective tier (which is also active for small free-tier teams — exactly
  // the audience the survey is for).
  if (config.enterpriseFeatures.core) return false;

  // The answers leave the instance, so respect the analytics opt-out
  // (ARCHESTRA_ANALYTICS=disabled — also how CI suppresses the dialog).
  if (!config.analytics.enabled) return false;

  const organization = await OrganizationModel.getById(organizationId);
  if (organization?.onboardingSurveyCompletedAt != null) return false;

  // "System has no data": no LLM proxy traffic and no MCP tool calls yet.
  const [interactionCount, mcpToolCallCount] = await Promise.all([
    InteractionModel.getCount(),
    McpToolCallModel.getCount(),
  ]);
  return interactionCount === 0 && mcpToolCallCount === 0;
}

/**
 * Best-effort: a failure (unreachable website, non-2xx) is only logged. The
 * caller marks the survey completed either way — losing one survey response
 * beats re-nagging an admin whose instance can't reach the website.
 */
async function forwardSurveyToWebsite(
  body: z.infer<typeof SubmitOnboardingSurveyBodySchema>,
): Promise<void> {
  const url = new URL("/api/onboarding-survey", WEBSITE_URL);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(SURVEY_FORWARD_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...body,
        archestraVersion: config.api.version,
      }),
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Onboarding survey forward rejected by website",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Onboarding survey forward failed");
  }
}

const SURVEY_FORWARD_TIMEOUT_MS = 10_000;
