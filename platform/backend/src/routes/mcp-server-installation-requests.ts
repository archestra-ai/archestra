import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import db, { schema } from "@/database";
import { McpServerInstallationRequestModel } from "@/models";
import {
  ErrorResponseSchema,
  InsertMcpServerInstallationRequestSchema,
  type McpServerInstallationRequest,
  McpServerInstallationRequestStatusSchema,
  RouteId,
  SelectMcpServerInstallationRequestSchema,
  UpdateMcpServerInstallationRequestSchema,
  UuidIdSchema,
} from "@/types";
import { getUserFromRequest } from "@/utils";

const mcpServerInstallationRequestRoutes: FastifyPluginAsyncZod = async (
  fastify,
) => {
  fastify.get(
    "/api/mcp_server_installation_requests",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationRequests,
        description: "Get all MCP server installation requests",
        tags: ["MCP Server Installation Requests"],
        querystring: z.object({
          status:
            McpServerInstallationRequestStatusSchema.optional().describe(
              "Filter by status",
            ),
        }),
        response: {
          200: z.array(SelectMcpServerInstallationRequestSchema),
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const { status } = request.query;

        // Admins can see all requests, non-admins can only see their own requests
        let requests: McpServerInstallationRequest[];
        if (user.isAdmin) {
          requests = status
            ? await McpServerInstallationRequestModel.findByStatus(status)
            : await McpServerInstallationRequestModel.findAll();
        } else {
          requests = await McpServerInstallationRequestModel.findByRequestedBy(
            user.id,
          );
          if (status) {
            requests = requests.filter((r) => r.status === status);
          }
        }

        return reply.send(requests);
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

  fastify.post(
    "/api/mcp_server_installation_requests",
    {
      schema: {
        operationId: RouteId.CreateMcpServerInstallationRequest,
        description: "Create a new MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        body: InsertMcpServerInstallationRequestSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
          requestedBy: true,
          status: true,
          reviewedBy: true,
          reviewedAt: true,
          adminResponse: true,
          notes: true,
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        // Check if there's already a pending request for this external catalog item
        if (request.body.externalCatalogId) {
          const existingExternalRequests =
            await McpServerInstallationRequestModel.findAll();
          const duplicateRequest = existingExternalRequests.find(
            (req) =>
              req.status === "pending" &&
              req.externalCatalogId === request.body.externalCatalogId,
          );

          if (duplicateRequest) {
            return reply.status(400).send({
              error: {
                message:
                  "A pending installation request already exists for this external MCP server",
                type: "bad_request",
              },
            });
          }
        }

        const newRequest = await McpServerInstallationRequestModel.create({
          ...request.body,
          requestedBy: user.id,
        });

        return reply.send(newRequest);
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

  fastify.get(
    "/api/mcp_server_installation_requests/:id",
    {
      schema: {
        operationId: RouteId.GetMcpServerInstallationRequest,
        description: "Get an MCP server installation request by ID",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.findById(request.params.id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        // Non-admins can only view their own requests
        if (!user.isAdmin && installationRequest.requestedBy !== user.id) {
          return reply.status(403).send({
            error: {
              message: "Forbidden",
              type: "forbidden",
            },
          });
        }

        return reply.send(installationRequest);
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

  fastify.patch(
    "/api/mcp_server_installation_requests/:id",
    {
      schema: {
        operationId: RouteId.UpdateMcpServerInstallationRequest,
        description:
          "Update an MCP server installation request (admin only for approval/decline)",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: UpdateMcpServerInstallationRequestSchema.omit({
          id: true,
          createdAt: true,
          updatedAt: true,
          externalCatalogId: true,
          requestedBy: true,
        }).partial(),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.findById(request.params.id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        // Only admins can update status
        if (
          request.body.status ||
          request.body.adminResponse ||
          request.body.reviewedBy ||
          request.body.reviewedAt
        ) {
          if (!user.isAdmin) {
            return reply.status(403).send({
              error: {
                message: "Only admins can approve or decline requests",
                type: "forbidden",
              },
            });
          }
        }

        const updatedRequest = await McpServerInstallationRequestModel.update(
          request.params.id,
          request.body,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
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

  fastify.post(
    "/api/mcp_server_installation_requests/:id/approve",
    {
      schema: {
        operationId: RouteId.ApproveMcpServerInstallationRequest,
        description: "Approve an MCP server installation request (admin only)",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          adminResponse: z.string().optional(),
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can approve requests",
              type: "forbidden",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.findById(request.params.id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        const updatedRequest = await McpServerInstallationRequestModel.approve(
          request.params.id,
          user.id,
          request.body.adminResponse,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
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

  fastify.post(
    "/api/mcp_server_installation_requests/:id/decline",
    {
      schema: {
        operationId: RouteId.DeclineMcpServerInstallationRequest,
        description: "Decline an MCP server installation request (admin only)",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          adminResponse: z.string().optional(),
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can decline requests",
              type: "forbidden",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.findById(request.params.id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        const updatedRequest = await McpServerInstallationRequestModel.decline(
          request.params.id,
          user.id,
          request.body.adminResponse,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
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

  fastify.post(
    "/api/mcp_server_installation_requests/:id/notes",
    {
      schema: {
        operationId: RouteId.AddMcpServerInstallationRequestNote,
        description: "Add a note to an MCP server installation request",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: z.object({
          content: z.string().min(1),
        }),
        response: {
          200: SelectMcpServerInstallationRequestSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        const installationRequest =
          await McpServerInstallationRequestModel.findById(request.params.id);

        if (!installationRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        // Non-admins can only add notes to their own requests
        if (!user.isAdmin && installationRequest.requestedBy !== user.id) {
          return reply.status(403).send({
            error: {
              message: "Forbidden",
              type: "forbidden",
            },
          });
        }

        // Get user name from database
        const [userData] = await db
          .select()
          .from(schema.usersTable)
          .where(eq(schema.usersTable.id, user.id));

        const updatedRequest = await McpServerInstallationRequestModel.addNote(
          request.params.id,
          user.id,
          userData.name,
          request.body.content,
        );

        if (!updatedRequest) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send(updatedRequest);
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

  fastify.delete(
    "/api/mcp_server_installation_requests/:id",
    {
      schema: {
        operationId: RouteId.DeleteMcpServerInstallationRequest,
        description: "Delete an MCP server installation request (admin only)",
        tags: ["MCP Server Installation Requests"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: {
          200: z.object({ success: z.boolean() }),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const user = await getUserFromRequest(request);

        if (!user) {
          return reply.status(401).send({
            error: {
              message: "Unauthorized",
              type: "unauthorized",
            },
          });
        }

        if (!user.isAdmin) {
          return reply.status(403).send({
            error: {
              message: "Only admins can delete requests",
              type: "forbidden",
            },
          });
        }

        const success = await McpServerInstallationRequestModel.delete(
          request.params.id,
        );

        if (!success) {
          return reply.status(404).send({
            error: {
              message: "Installation request not found",
              type: "not_found",
            },
          });
        }

        return reply.send({ success });
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

export default mcpServerInstallationRequestRoutes;
