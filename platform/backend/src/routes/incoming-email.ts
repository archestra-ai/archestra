import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getEmailProvider,
  getSubscriptionStatus,
  type OutlookEmailProvider,
  processIncomingEmail,
} from "@/agents/incoming-email";
import logger from "@/logging";
import { PromptModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
} from "@/types";

/**
 * Incoming Email webhook routes
 * Handles email notifications from providers and invokes agents
 */

/**
 * Schema for subscription status response
 */
const SubscriptionStatusSchema = z.object({
  isActive: z.boolean(),
  subscription: z
    .object({
      id: z.string(),
      subscriptionId: z.string(),
      provider: z.string(),
      webhookUrl: z.string(),
      expiresAt: z.string().datetime(),
    })
    .nullable(),
});

/**
 * Schema for setup response
 */
const SetupResponseSchema = z.object({
  success: z.boolean(),
  subscriptionId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  message: z.string().optional(),
});

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
      // Microsoft Graph sends validationToken as query parameter
      const query = request.query as { validationToken?: string };
      if (query.validationToken) {
        logger.info(
          "[IncomingEmail] Responding to validation challenge from query param",
        );
        return reply.type("text/plain").send(query.validationToken);
      }

      // Also check body for validation token (fallback)
      const validationResponse = provider.handleValidationChallenge(
        request.body,
      );
      if (validationResponse !== null) {
        logger.info(
          "[IncomingEmail] Responding to validation challenge from body",
        );
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
              stack: error instanceof Error ? error.stack : undefined,
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
        operationId: RouteId.GetPromptEmailAddress,
        description: "Get the email address for invoking an agent",
        tags: ["Prompts"],
        params: z.object({
          promptId: z.string().uuid(),
        }),
        response: constructResponseSchema(
          z.object({
            enabled: z.boolean(),
            emailAddress: z.string().nullable(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { promptId } = request.params;

      // Verify prompt exists
      const prompt = await PromptModel.findById(promptId);
      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
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
   * Get the current subscription status
   */
  fastify.get(
    "/api/incoming-email/status",
    {
      schema: {
        operationId: RouteId.GetIncomingEmailStatus,
        description:
          "Get the current incoming email webhook subscription status",
        tags: ["Incoming Email"],
        response: constructResponseSchema(SubscriptionStatusSchema),
      },
    },
    async (_, reply) => {
      const status = await getSubscriptionStatus();

      if (!status) {
        return reply.send({
          isActive: false,
          subscription: null,
        });
      }

      return reply.send({
        isActive: status.isActive,
        subscription: {
          id: status.id,
          subscriptionId: status.subscriptionId,
          provider: status.provider,
          webhookUrl: status.webhookUrl,
          expiresAt: status.expiresAt.toISOString(),
        },
      });
    },
  );

  /**
   * Endpoint to manually setup/renew webhook subscription
   * Used for initial setup and periodic renewal
   */
  fastify.post(
    "/api/incoming-email/setup",
    {
      schema: {
        operationId: RouteId.SetupIncomingEmailWebhook,
        description: "Setup or renew incoming email webhook subscription",
        tags: ["Incoming Email"],
        body: z.object({
          webhookUrl: z.string().url(),
        }),
        response: constructResponseSchema(SetupResponseSchema),
      },
    },
    async (request, reply) => {
      const provider = getEmailProvider();

      if (!provider) {
        throw new ApiError(400, "Incoming email provider not configured");
      }

      const { webhookUrl } = request.body;

      // For Outlook provider, create/renew subscription
      if (provider.providerId === "outlook") {
        const outlookProvider = provider as OutlookEmailProvider;

        // Check for existing active subscription to prevent duplicates
        const existingStatus = await outlookProvider.getSubscriptionStatus();
        if (existingStatus?.isActive) {
          // Delete the old subscription before creating a new one
          logger.info(
            {
              existingSubscriptionId: existingStatus.subscriptionId,
              newWebhookUrl: webhookUrl,
            },
            "[IncomingEmail] Deleting existing subscription before creating new one",
          );
          await outlookProvider.deleteSubscription(
            existingStatus.subscriptionId,
          );
        }

        const subscription =
          await outlookProvider.createSubscription(webhookUrl);

        return reply.send({
          success: true,
          subscriptionId: subscription.subscriptionId,
          expiresAt: subscription.expiresAt.toISOString(),
          message: "Webhook subscription created successfully",
        });
      }

      return reply.send({
        success: true,
        message: "Webhook setup completed",
      });
    },
  );

  /**
   * Renew the current subscription
   */
  fastify.post(
    "/api/incoming-email/renew",
    {
      schema: {
        operationId: RouteId.RenewIncomingEmailSubscription,
        description: "Renew the incoming email webhook subscription",
        tags: ["Incoming Email"],
        response: constructResponseSchema(SetupResponseSchema),
      },
    },
    async (_, reply) => {
      const provider = getEmailProvider();

      if (!provider) {
        throw new ApiError(400, "Incoming email provider not configured");
      }

      const status = await getSubscriptionStatus();
      if (!status) {
        throw new ApiError(404, "No subscription found to renew");
      }

      // For Outlook provider, renew subscription
      if (provider.providerId === "outlook") {
        const outlookProvider = provider as OutlookEmailProvider;
        const newExpiresAt = await outlookProvider.renewSubscription(
          status.subscriptionId,
        );

        return reply.send({
          success: true,
          subscriptionId: status.subscriptionId,
          expiresAt: newExpiresAt.toISOString(),
          message: "Webhook subscription renewed successfully",
        });
      }

      return reply.send({
        success: true,
        message: "Subscription renewed",
      });
    },
  );

  /**
   * Delete the current subscription
   */
  fastify.delete(
    "/api/incoming-email/subscription",
    {
      schema: {
        operationId: RouteId.DeleteIncomingEmailSubscription,
        description: "Delete the incoming email webhook subscription",
        tags: ["Incoming Email"],
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (_, reply) => {
      const provider = getEmailProvider();

      if (!provider) {
        throw new ApiError(400, "Incoming email provider not configured");
      }

      const status = await getSubscriptionStatus();
      if (!status) {
        throw new ApiError(404, "No subscription found to delete");
      }

      // For Outlook provider, delete subscription
      if (provider.providerId === "outlook") {
        const outlookProvider = provider as OutlookEmailProvider;
        await outlookProvider.deleteSubscription(status.subscriptionId);
      }

      return reply.send({ success: true });
    },
  );
};

export default incomingEmailRoutes;
