import type { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { EntityLabelModel } from "@/models/entity-label";
import { constructResponseSchema, LabelWithDetailsSchema } from "@/types";

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
    setOperationId: RouteId;
    /**
     * Per-row authorization for the write endpoint.
     *
     * The route gate only checks the caller holds the entity's `update`
     * permission, which says nothing about *this* row — several labelled
     * entities are team-scoped or personally owned. Each registration site
     * passes the same helper its own update route uses, so relabelling is
     * exactly as restricted as editing, and must throw (404/403) when the
     * caller may not modify the row.
     */
    assertCanModify: (params: {
      id: string;
      userId: string;
      organizationId: string;
    }) => Promise<unknown>;
  },
): void {
  const {
    basePath,
    tag,
    entityNamePlural,
    model,
    keysOperationId,
    valuesOperationId,
    setOperationId,
    assertCanModify,
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

  fastify.put(
    `${basePath}/:id/labels`,
    {
      schema: {
        operationId: setOperationId,
        description:
          `Replace the labels on one of the ${entityNamePlural}. ` +
          "Labels-only, so a row can be relabelled without resending the " +
          "rest of its update payload — several entities validate across " +
          "fields, or rewrite versioned content, on their normal update.",
        tags: [tag],
        params: z.object({ id: z.string() }),
        body: z.object({
          labels: z
            .array(LabelWithDetailsSchema)
            .describe("The complete label set. `[]` clears them."),
        }),
        response: constructResponseSchema(z.array(LabelWithDetailsSchema)),
      },
    },
    async ({ params: { id }, body, user, organizationId }, reply) => {
      await assertCanModify({ id, userId: user.id, organizationId });
      await model.syncLabels(id, body.labels);
      return reply.send(await model.getLabelsFor(id));
    },
  );
}
