import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { McpPresetEntryModel } from "@/models";
import {
  constructResponseSchema,
  McpPresetEntryWithAssignedCountSchema,
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
};

export default mcpPresetEntryRoutes;
