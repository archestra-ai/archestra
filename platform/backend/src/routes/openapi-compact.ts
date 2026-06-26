import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { enrichOpenApiWithRbac } from "@/openapi/enrich-openapi-with-rbac";
import { projectCompactOpenApi } from "@/openapi/project-compact-openapi";

/**
 * Compact, request-focused projection of the OpenAPI spec for agent-driven
 * discovery (the archestra__api tool / Platform Operations skill). The full
 * `/openapi.json` is ~9MB of inlined response schemas; this drops responses and
 * descriptions, keeping method/path, request shape, and `x-required-permissions`
 * per operation. `?path=/api/agents` narrows to one route group.
 *
 * Lives under `/api/*` so it rides the normal auth middleware (any authenticated
 * user) and the archestra__api allowlist — unlike the public bare `/openapi.json`.
 */
const openapiCompactRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/openapi-compact",
    {
      schema: {
        operationId: RouteId.GetCompactOpenApi,
        description:
          "Compact, request-focused OpenAPI index for route discovery. Optional `path` narrows to one group, e.g. /api/agents.",
        tags: ["OpenAPI"],
        querystring: z.object({
          path: z.string().optional(),
        }),
        response: {
          200: z.record(z.string(), z.unknown()),
        },
      },
    },
    async (request) => {
      const enriched = enrichOpenApiWithRbac(fastify.swagger());
      const compact = projectCompactOpenApi(enriched, {
        pathPrefix: request.query.path,
      });
      // OpenApiDoc is a named interface; the loose `z.record` response schema
      // wants an index-signature shape. The doc is freeform JSON at runtime.
      return compact as Record<string, unknown>;
    },
  );
};

export default openapiCompactRoutes;
