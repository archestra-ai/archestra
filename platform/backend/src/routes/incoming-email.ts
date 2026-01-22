import { IncomingEmailSecurityModeSchema, RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  getEmailProvider,
  getSubscriptionStatus,
  type OutlookEmailProvider,
  processIncomingEmail,
} from "@/agents/incoming-email";
import { isRateLimited } from "@/agents/utils";
import { type AllowedCacheKey, CacheKey } from "@/cache-manager";
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
 * Rate limit configuration for webhook endpoint
 * Limits requests per IP address to prevent abuse
 */
const RATE_LIMIT_CONFIG = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60, // 60 requests per minute per IP
};

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
          429: z.object({
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
      // Validation challenges bypass rate limiting
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

      // Apply rate limiting to actual webhook notifications (not validation challenges)
      const clientIp = request.ip || "unknown";
      const rateLimitKey =
        `${CacheKey.WebhookRateLimit}-${clientIp}` as AllowedCacheKey;
      if (await isRateLimited(rateLimitKey, RATE_LIMIT_CONFIG)) {
        logger.warn(
          { ip: clientIp },
          "[IncomingEmail] Rate limit exceeded for webhook",
        );
        return reply.status(429).send({
          error: "Too many requests",
        });
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
          await processIncomingEmail(email, provider, { sendReply: true });
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
        /**
         * Schema for email address response
         * Includes both global provider status and agent-level settings
         */
        response: constructResponseSchema(
          z.object({
            // Global incoming email provider status
            providerEnabled: z.boolean(),
            emailAddress: z.string().nullable(),
            // Agent-level incoming email settings
            agentIncomingEmailEnabled: z.boolean(),
            agentSecurityMode: IncomingEmailSecurityModeSchema,
            agentAllowedDomain: z.string().nullable(),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { promptId } = request.params;

      // Get prompt's incoming email settings
      const prompt = await PromptModel.findById(promptId);
      if (!prompt) {
        throw new ApiError(404, "Prompt not found");
      }

      const provider = getEmailProvider();

      if (!provider) {
        return reply.send({
          providerEnabled: false,
          emailAddress: null,
          agentIncomingEmailEnabled: prompt.incomingEmailEnabled,
          agentSecurityMode: prompt.incomingEmailSecurityMode,
          agentAllowedDomain: prompt.incomingEmailAllowedDomain,
        });
      }

      const emailAddress = provider.generateEmailAddress(promptId);

      return reply.send({
        providerEnabled: true,
        emailAddress,
        agentIncomingEmailEnabled: prompt.incomingEmailEnabled,
        agentSecurityMode: prompt.incomingEmailSecurityMode,
        agentAllowedDomain: prompt.incomingEmailAllowedDomain,
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
        response: constructResponseSchema(
          z.object({
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
          }),
        ),
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

        // Clean up ALL existing subscriptions from Microsoft Graph
        // This prevents stale subscriptions (from previous dev sessions, database resets, etc.)
        // from sending webhooks with mismatched clientState values
        logger.info(
          "[IncomingEmail] Cleaning up all existing Graph subscriptions before creating new one",
        );
        const deleted = await outlookProvider.deleteAllGraphSubscriptions();
        if (deleted > 0) {
          logger.info(
            { deleted },
            "[IncomingEmail] Cleaned up existing Graph subscriptions",
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
