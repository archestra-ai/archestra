import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getEmailProvider,
  type IncomingEmail,
  type OutlookEmailProvider,
} from "@/agents/incoming-email";
import logger from "@/logging";
import { AgentTeamModel, PromptModel, TeamModel } from "@/models";
import { executeA2AMessage } from "@/services/a2a-executor";

/**
 * Incoming Email webhook routes
 * Handles email notifications from providers and invokes agents
 */

const incomingEmailRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Webhook endpoint for incoming email notifications
   *
   * This endpoint receives notifications from email providers (e.g., Microsoft Graph)
   * when new emails arrive. It then:
   * 1. Validates the webhook request
   * 2. Parses the email notification
   * 3. Extracts the promptId from the email address
   * 4. Invokes the agent with the email body as the message
   */
  fastify.post(
    "/api/webhooks/incoming-email",
    {
      schema: {
        description: "Webhook endpoint for incoming email notifications",
        tags: ["Webhooks"],
        // Accept any body - email providers have different payload formats
        body: z.unknown(),
        response: {
          200: z.union([
            z.string(), // Validation token response
            z.object({
              success: z.boolean(),
              processed: z.number().optional(),
              errors: z.number().optional(),
            }),
          ]),
          400: z.object({
            error: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const provider = getEmailProvider();

      if (!provider) {
        logger.warn(
          "[IncomingEmail] Webhook called but no provider configured",
        );
        return reply.status(400).send({
          error: "Incoming email provider not configured",
        });
      }

      // Handle validation challenge (initial webhook setup)
      const validationResponse = provider.handleValidationChallenge(
        request.body,
      );
      if (validationResponse !== null) {
        logger.info("[IncomingEmail] Responding to validation challenge");
        // Microsoft Graph expects plain text response for validation
        return reply.type("text/plain").send(validationResponse);
      }

      // Validate webhook request
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = value;
      }

      const isValid = await provider.validateWebhookRequest(
        request.body,
        headers,
      );
      if (!isValid) {
        logger.warn("[IncomingEmail] Invalid webhook request");
        return reply.status(400).send({
          error: "Invalid webhook request",
        });
      }

      // Parse email notifications
      const emails = await provider.parseWebhookNotification(
        request.body,
        headers,
      );

      if (!emails || emails.length === 0) {
        logger.debug("[IncomingEmail] No emails to process in notification");
        return reply.send({
          success: true,
          processed: 0,
        });
      }

      // Process each email
      let processed = 0;
      let errors = 0;

      for (const email of emails) {
        try {
          await processIncomingEmail(email, provider);
          processed++;
        } catch (error) {
          errors++;
          logger.error(
            {
              messageId: email.messageId,
              fromAddress: email.fromAddress,
              error: error instanceof Error ? error.message : String(error),
            },
            "[IncomingEmail] Failed to process email",
          );
        }
      }

      logger.info(
        { processed, errors, total: emails.length },
        "[IncomingEmail] Finished processing webhook notification",
      );

      return reply.send({
        success: errors === 0,
        processed,
        errors: errors > 0 ? errors : undefined,
      });
    },
  );

  /**
   * Endpoint to get the agent email address for a prompt
   * Used by the frontend to display the email address for an agent
   */
  fastify.get(
    "/api/prompts/:promptId/email-address",
    {
      schema: {
        description: "Get the email address for invoking an agent",
        tags: ["Prompts"],
        params: z.object({
          promptId: z.string().uuid(),
        }),
        response: {
          200: z.object({
            enabled: z.boolean(),
            emailAddress: z.string().nullable(),
          }),
          404: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const { promptId } = request.params;

      // Verify prompt exists
      const prompt = await PromptModel.findById(promptId);
      if (!prompt) {
        return reply.status(404).send({
          error: "Prompt not found",
        });
      }

      const provider = getEmailProvider();

      if (!provider) {
        return reply.send({
          enabled: false,
          emailAddress: null,
        });
      }

      const emailAddress = provider.generateEmailAddress(promptId);

      return reply.send({
        enabled: true,
        emailAddress,
      });
    },
  );

  /**
   * Endpoint to manually setup/renew webhook subscription
   * Used for initial setup and periodic renewal
   */
  fastify.post(
    "/api/webhooks/incoming-email/setup",
    {
      schema: {
        description: "Setup or renew incoming email webhook subscription",
        tags: ["Webhooks"],
        body: z.object({
          webhookUrl: z.string().url().optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            subscriptionId: z.string().optional(),
            message: z.string().optional(),
          }),
          400: z.object({
            error: z.string(),
          }),
          500: z.object({
            error: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const provider = getEmailProvider();

      if (!provider) {
        return reply.status(400).send({
          error: "Incoming email provider not configured",
        });
      }

      // Construct webhook URL from request or use provided one
      const webhookUrl =
        request.body.webhookUrl ||
        `${request.headers["x-forwarded-proto"] || "http"}://${request.headers.host}/api/webhooks/incoming-email`;

      try {
        // For Outlook provider, create/renew subscription
        if (provider.providerId === "outlook") {
          const outlookProvider = provider as OutlookEmailProvider;
          const subscriptionId =
            await outlookProvider.createSubscription(webhookUrl);

          return reply.send({
            success: true,
            subscriptionId,
            message: "Webhook subscription created successfully",
          });
        }

        return reply.send({
          success: true,
          message: "Webhook setup completed",
        });
      } catch (error) {
        logger.error(
          {
            provider: provider.providerId,
            error: error instanceof Error ? error.message : String(error),
          },
          "[IncomingEmail] Failed to setup webhook",
        );

        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Failed to setup webhook",
        });
      }
    },
  );
};

/**
 * Process an incoming email and invoke the appropriate agent
 */
async function processIncomingEmail(
  email: IncomingEmail,
  provider: ReturnType<typeof getEmailProvider>,
): Promise<void> {
  if (!provider) {
    throw new Error("No email provider configured");
  }

  logger.info(
    {
      messageId: email.messageId,
      toAddress: email.toAddress,
      fromAddress: email.fromAddress,
      subject: email.subject,
    },
    "[IncomingEmail] Processing incoming email",
  );

  // Extract promptId from the email address
  let promptId: string | null = null;

  if (provider.providerId === "outlook") {
    const outlookProvider = provider as OutlookEmailProvider;
    promptId = outlookProvider.extractPromptIdFromEmail(email.toAddress);
  }

  if (!promptId) {
    throw new Error(
      `Could not extract promptId from email address: ${email.toAddress}`,
    );
  }

  // Verify prompt exists
  const prompt = await PromptModel.findById(promptId);
  if (!prompt) {
    throw new Error(`Prompt ${promptId} not found`);
  }

  // Get organization from agent's team
  const agentTeamIds = await AgentTeamModel.getTeamsForAgent(prompt.agentId);
  if (agentTeamIds.length === 0) {
    throw new Error(`No teams found for agent ${prompt.agentId}`);
  }

  const teams = await TeamModel.findByIds(agentTeamIds);
  if (teams.length === 0 || !teams[0].organizationId) {
    throw new Error(`No organization found for agent ${prompt.agentId}`);
  }
  const organization = teams[0].organizationId;

  // Use email body as the message to invoke the agent
  // If body is empty, use the subject line
  const message = email.body.trim() || email.subject || "No message content";

  logger.info(
    {
      promptId,
      agentId: prompt.agentId,
      organizationId: organization,
      messageLength: message.length,
    },
    "[IncomingEmail] Invoking agent with email content",
  );

  // Execute using the shared A2A service
  const result = await executeA2AMessage({
    promptId,
    message,
    organizationId: organization,
    userId: "system", // Email invocations use system context
  });

  logger.info(
    {
      promptId,
      messageId: result.messageId,
      responseLength: result.text.length,
      finishReason: result.finishReason,
    },
    "[IncomingEmail] Agent execution completed",
  );

  // TODO: Optionally send the response back via email
  // This would require implementing reply functionality in the provider
}

export default incomingEmailRoutes;
