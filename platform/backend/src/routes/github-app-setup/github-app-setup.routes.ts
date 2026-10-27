import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { githubAppManifestSetup } from "@/services/github-app-manifest-setup";
import { constructResponseSchema } from "@/types";
import {
  CompleteGithubAppResultSchema,
  CompleteGithubAppSchema,
} from "@/types/github-app-manifest-setup";
// Each flow registers itself with the shared setup when its module loads.
import "@/services/openappa-github-app-setup";
import "@/services/github-copilot-app-setup";

/**
 * GitHub's return from creating a GitHub App from a manifest. One route for
 * every setup that registers Apps (Guardrails, GitHub Copilot): the flow saved
 * with the state decides which setup it belongs to and who may finish it.
 */
const githubAppSetupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/api/github-app-setup/complete",
    {
      schema: {
        operationId: RouteId.CompleteGithubAppSetup,
        description:
          "Exchange GitHub's one-time code for the new App; the setup that started it stores it once installed",
        tags: ["GitHub App setup"],
        body: CompleteGithubAppSchema,
        response: constructResponseSchema(CompleteGithubAppResultSchema),
      },
    },
    async (request, reply) => {
      // Only a short-lived setup record changes; the stored credential is
      // audited when installation completes.
      request.auditSkip = true;
      return reply.send(
        await githubAppManifestSetup.complete({
          organizationId: request.organizationId,
          userId: request.user.id,
          ...request.body,
        }),
      );
    },
  );
};

export default githubAppSetupRoutes;
