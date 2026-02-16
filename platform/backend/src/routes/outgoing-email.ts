import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { AgentModel } from "@/models";
import {
  isOutgoingEmailEnabled,
  sendOutgoingEmail,
} from "@/services/outgoing-email.service";
import { ApiError, constructResponseSchema, UuidIdSchema } from "@/types";

const SendOutgoingEmailBodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(998),
  text: z.string().min(1).max(20000),
  html: z.string().max(50000).optional(),
  fromName: z.string().max(120).optional(),
});

const outgoingEmailRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/agents/:agentId/outgoing-email",
    {
      schema: {
        operationId: RouteId.SendAgentOutgoingEmail,
        description:
          "Send an outbound email from an agent using configured provider",
        tags: ["Outgoing Email", "Agents"],
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: SendOutgoingEmailBodySchema,
        response: constructResponseSchema(
          z.object({
            provider: z.literal("gmail_api"),
            messageId: z.string(),
            accepted: z.array(z.string()),
            rejected: z.array(z.string()),
          }),
        ),
      },
    },
    async ({ params: { agentId }, body, headers, user }, reply) => {
      if (!isOutgoingEmailEnabled()) {
        throw new ApiError(
          400,
          "Outgoing email is not configured. Enable Gmail API env vars first.",
        );
      }

      const { success: isAgentAdmin } = await hasPermission(
        { profile: ["admin"] },
        headers,
      );

      const agent = await AgentModel.findById(agentId, user.id, isAgentAdmin);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      const result = await sendOutgoingEmail({
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
        fromName: body.fromName || agent.name,
      });

      return reply.send(result);
    },
  );
};

export default outgoingEmailRoutes;
