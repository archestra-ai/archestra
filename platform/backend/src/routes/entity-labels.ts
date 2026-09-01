import type { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { EntityLabelModel } from "@/models/entity-label";
import { constructResponseSchema } from "@/types";

/** The Zod-typed Fastify instance every route plugin in this codebase gets. */
type ZodFastifyInstance = Parameters<FastifyPluginAsyncZod>[0];

/**
 * Register the two label-vocabulary endpoints an entity's filter UI needs:
 * `<basePath>/labels/keys` and `<basePath>/labels/values`.
 *
 * These are identical for every labelled entity apart from the model they read
 * and the operation ids they publish, so they are registered from a config
 * rather than repeated per entity.
 *
 * Both are organization-scoped by the model, so a filter dropdown never offers
 * a key or value from another organization's rows.
 */
export function registerEntityLabelRoutes(
  fastify: ZodFastifyInstance,
  options: {
    /** Collection path the labels hang off, e.g. `/api/skills`. */
    basePath: string;
    /** OpenAPI tag, matching the entity's other routes. */
    tag: string;
    /** Plural entity name for the endpoint descriptions, e.g. `skills`. */
    entityNamePlural: string;
    model: EntityLabelModel;
    keysOperationId: RouteId;
    valuesOperationId: RouteId;
  },
): void {
  const {
    basePath,
    tag,
    entityNamePlural,
    model,
    keysOperationId,
    valuesOperationId,
  } = options;

  fastify.get(
    `${basePath}/labels/keys`,
    {
      schema: {
        operationId: keysOperationId,
        description: `Get all label keys used by ${entityNamePlural}`,
        tags: [tag],
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await model.getAllKeys(organizationId));
    },
  );

  fastify.get(
    `${basePath}/labels/values`,
    {
      schema: {
        operationId: valuesOperationId,
        description: `Get all label values used by ${entityNamePlural}`,
        tags: [tag],
        querystring: z.object({
          key: z.string().optional().describe("Filter values by label key"),
        }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ query: { key }, organizationId }, reply) => {
      return reply.send(
        key
          ? await model.getValuesByKey({ organizationId, key })
          : await model.getAllValues(organizationId),
      );
    },
  );
}
