import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { ToolPolicyModel } from "@/models";
import {
  constructResponseSchema,
  InsertToolPolicySchema,
  SelectToolPolicySchema,
  UpdateToolPolicySchema,
  UuidIdSchema,
} from "@/types";

const toolPolicyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET /api/tool-policies - List all tool policies (with optional filtering)
  fastify.get(
    "/api/tool-policies",
    {
      schema: {
        operationId: RouteId.GetToolPolicies,
        description: "Get all tool policies with optional filtering",
        tags: ["Tool Policies"],
        querystring: z.object({
          toolId: UuidIdSchema.optional(),
          organizationId: z.string().optional(),
        }),
        response: constructResponseSchema(z.array(SelectToolPolicySchema)),
      },
    },
    async ({ query, headers }, reply) => {
      try {
        await hasPermission({ profile: ["read"] }, headers);

        const policies = await ToolPolicyModel.findAll({
          toolId: query.toolId,
          organizationId: query.organizationId,
        });

        return reply.send(policies);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  // GET /api/tool-policies/:id - Get a single tool policy by ID
  fastify.get(
    "/api/tool-policies/:id",
    {
      schema: {
        operationId: RouteId.GetToolPolicyById,
        description: "Get a tool policy by ID",
        tags: ["Tool Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectToolPolicySchema),
      },
    },
    async ({ params, headers }, reply) => {
      try {
        await hasPermission({ profile: ["read"] }, headers);

        const policy = await ToolPolicyModel.findById(params.id);

        if (!policy) {
          return reply.status(404).send({
            error: {
              message: "Tool policy not found",
              type: "not_found",
            },
          });
        }

        return reply.send(policy);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  // POST /api/tool-policies - Create a new tool policy
  fastify.post(
    "/api/tool-policies",
    {
      schema: {
        operationId: RouteId.CreateToolPolicy,
        description: "Create a new tool policy",
        tags: ["Tool Policies"],
        body: InsertToolPolicySchema,
        response: constructResponseSchema(SelectToolPolicySchema),
      },
    },
    async ({ body, headers }, reply) => {
      try {
        await hasPermission({ profile: ["write"] }, headers);

        const policy = await ToolPolicyModel.create(body);

        return reply.status(201).send(policy);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  // PUT /api/tool-policies/:id - Update a tool policy
  fastify.put(
    "/api/tool-policies/:id",
    {
      schema: {
        operationId: RouteId.UpdateToolPolicy,
        description: "Update a tool policy",
        tags: ["Tool Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateToolPolicySchema.partial(),
        response: constructResponseSchema(SelectToolPolicySchema),
      },
    },
    async ({ params, body, headers }, reply) => {
      try {
        await hasPermission({ profile: ["write"] }, headers);

        const policy = await ToolPolicyModel.update(params.id, body);

        if (!policy) {
          return reply.status(404).send({
            error: {
              message: "Tool policy not found",
              type: "not_found",
            },
          });
        }

        return reply.send(policy);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  // DELETE /api/tool-policies/:id - Delete a tool policy
  fastify.delete(
    "/api/tool-policies/:id",
    {
      schema: {
        operationId: RouteId.DeleteToolPolicy,
        description: "Delete a tool policy",
        tags: ["Tool Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
          }),
        ),
      },
    },
    async ({ params, headers }, reply) => {
      try {
        await hasPermission({ profile: ["write"] }, headers);

        const deleted = await ToolPolicyModel.delete(params.id);

        if (!deleted) {
          return reply.status(404).send({
            error: {
              message: "Tool policy not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );

  // GET /api/tool-policies/:id/assignments - Get agent assignments for a tool policy
  fastify.get(
    "/api/tool-policies/:id/assignments",
    {
      schema: {
        operationId: RouteId.GetToolPolicyAssignments,
        description: "Get agent assignments for a tool policy",
        tags: ["Tool Policies"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(
            z.object({
              agentId: z.string(),
              agentName: z.string(),
            }),
          ),
        ),
      },
    },
    async ({ params, headers }, reply) => {
      try {
        await hasPermission({ profile: ["read"] }, headers);

        const assignments = await ToolPolicyModel.getAgentAssignments(
          params.id,
        );

        return reply.send(assignments);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "api_error",
          },
        });
      }
    },
  );
};

export default toolPolicyRoutes;
