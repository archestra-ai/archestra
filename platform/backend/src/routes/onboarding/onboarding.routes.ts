import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { OrganizationModel, UserOnboardingSeenItemModel } from "@/models";
import { telemetryPreference } from "@/observability/telemetry-preference";
import { constructResponseSchema } from "@/types";

const SeenNavItemsResponseSchema = z.object({
  items: z.array(z.string()),
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
    "/api/onboarding/first-run-setup",
    {
      schema: {
        operationId: RouteId.GetFirstRunSetup,
        description:
          "Whether the first-run setup dialog (mailing-list signup and telemetry choice) should be shown: unlicensed instance, telemetry not turned off for the deployment, not already finished for the organization",
        tags: ["Onboarding"],
        response: constructResponseSchema(z.object({ show: z.boolean() })),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send({
        show: await shouldShowFirstRunSetup(organizationId),
      });
    },
  );

  fastify.post(
    "/api/onboarding/first-run-setup",
    {
      schema: {
        operationId: RouteId.CompleteFirstRunSetup,
        description:
          "Finish the first-run setup dialog: store the telemetry choice. Recorded once per organization",
        tags: ["Onboarding"],
        body: CompleteFirstRunSetupBodySchema,
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ body, organizationId }, reply) => {
      // Only the first completion counts, so two admins finishing
      // concurrently cannot overwrite each other's telemetry choice.
      const isFirstCompletion = await OrganizationModel.completeFirstRunSetup({
        id: organizationId,
        telemetryEnabled: body.telemetryEnabled,
      });
      if (isFirstCompletion) {
        telemetryPreference.remember(body.telemetryEnabled);
      }
      return reply.send({ ok: true });
    },
  );
};

export default onboardingRoutes;

// === Internal helpers ===

const CompleteFirstRunSetupBodySchema = z.object({
  telemetryEnabled: z.boolean(),
});

async function shouldShowFirstRunSetup(
  organizationId: string,
): Promise<boolean> {
  // Never on licensed instances. The raw env flag, deliberately not the
  // effective tier (which is also active for small free-tier teams, the
  // audience this dialog is for).
  if (config.enterpriseFeatures.core) return false;

  // A deployment that set ARCHESTRA_ANALYTICS=disabled already made the
  // telemetry choice and does not want to be contacted. This is also how
  // local development and CI keep the dialog closed.
  if (!config.analytics.enabled) return false;

  const organization = await OrganizationModel.getById(organizationId);
  return organization != null && organization.firstRunSetupCompletedAt == null;
}
