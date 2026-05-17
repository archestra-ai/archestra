import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpPresetEntryModel } from "@/models";
import {
  ApiError,
  CreateMcpPresetEntrySchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  McpPresetEntryWithAssignedCountSchema,
  SelectMcpPresetEntrySchema,
  UuidIdSchema,
} from "@/types";

const mcpPresetEntryRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization/mcp-preset-entries",
    {
      schema: {
        operationId: RouteId.ListMcpPresetEntries,
        description:
          "List org-level preset entries (e.g. Production, Staging). Includes an assignedCatalogCount so the UI can render a delete-confirmation count.",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.array(McpPresetEntryWithAssignedCountSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      const entries =
        await McpPresetEntryModel.listForOrganization(organizationId);
      return reply.send(entries);
    },
  );

  fastify.post(
    "/api/organization/mcp-preset-entries",
    {
      schema: {
        operationId: RouteId.CreateMcpPresetEntry,
        description:
          "Create an org-level preset entry. Name is immutable after creation — there is no update endpoint.",
        tags: ["Organization"],
        body: CreateMcpPresetEntrySchema,
        response: constructResponseSchema(SelectMcpPresetEntrySchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const existing =
        await McpPresetEntryModel.listForOrganization(organizationId);
      if (existing.some((e) => e.name === body.name)) {
        throw new ApiError(409, "An entry with this name already exists.");
      }

      const entry = await McpPresetEntryModel.create({
        organizationId,
        name: body.name,
      });
      return reply.send(entry);
    },
  );

  fastify.delete(
    "/api/organization/mcp-preset-entries/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpPresetEntry,
        description:
          "Delete an org-level preset entry. Cascade-deletes every per-catalog child that references it.",
        tags: ["Organization"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, params }, reply) => {
      const deleted = await McpPresetEntryModel.delete(
        params.id,
        organizationId,
      );
      if (!deleted) {
        throw new ApiError(404, "Preset entry not found");
      }
      return reply.send({ success: true });
    },
  );
};

export default mcpPresetEntryRoutes;
