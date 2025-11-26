import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import config from "@/config";
import { SsoProviderModel, UserModel, MemberModel, OrganizationModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";
import logger from "@/logging";

const ssoAuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Initiate SSO sign-in
  fastify.post(
    "/api/auth/sso/sign-in/:providerId",
    {
      schema: {
        operationId: "initiateSsoSignIn",
        description: "Initiate SSO sign-in flow",
        tags: ["SSO Auth"],
        params: z.object({
          providerId: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            url: z.string().url(),
          }),
        ),
      },
    },
    async ({ params: { providerId } }, reply) => {
      const provider = await SsoProviderModel.getById(providerId);

      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }

      if (!provider.enabled) {
        throw new ApiError(400, "SSO provider is disabled");
      }

      // Generate authorization URL based on provider type
      // This is a simplified implementation - in production, you'd use proper OIDC/SAML libraries
      let authUrl: string;

      if (provider.type === "oidc") {
        // For OIDC, construct the authorization URL
        const baseUrl = config.baseURL || "http://localhost:3000";
        const callbackUrl = `${baseUrl}/api/auth/sso/callback/${providerId}`;
        const state = crypto.randomUUID();
        const scopes = provider.scopes || "openid profile email";

        // Store state in session/cookie for verification
        // In production, use proper session management

        const authEndpoint =
          provider.authorizationEndpoint ||
          `${provider.issuer}/authorize`;

        const params = new URLSearchParams({
          client_id: provider.clientId!,
          redirect_uri: callbackUrl,
          response_type: "code",
          scope: scopes,
          state,
        });

        authUrl = `${authEndpoint}?${params.toString()}`;
      } else if (provider.type === "saml") {
        // For SAML, redirect to the entry point
        // In production, you'd generate a proper SAML AuthnRequest
        const baseUrl = config.baseURL || "http://localhost:3000";
        const callbackUrl = `${baseUrl}/api/auth/sso/callback/${providerId}`;

        // SAML implementation would require generating an AuthnRequest
        // For now, redirect to entry point with callback URL
        authUrl = provider.entryPoint!;
      } else {
        throw new ApiError(400, "Unsupported SSO provider type");
      }

      return reply.send({ url: authUrl });
    },
  );

  // SSO callback handler
  fastify.get(
    "/api/auth/sso/callback/:providerId",
    {
      schema: {
        operationId: "handleSsoCallback",
        description: "Handle SSO callback",
        tags: ["SSO Auth"],
        params: z.object({
          providerId: z.string().min(1),
        }),
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async ({ params: { providerId }, query }, reply) => {
      const provider = await SsoProviderModel.getById(providerId);

      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }

      // Handle error from identity provider
      if (query.error) {
        logger.error(
          { error: query.error, description: query.error_description },
          "SSO callback error",
        );
        return reply.redirect(
          `/auth/sign-in?error=${encodeURIComponent(query.error_description || query.error)}`,
        );
      }

      // For OIDC, exchange code for tokens
      if (provider.type === "oidc" && query.code) {
        try {
          // In production, exchange authorization code for tokens
          // This is a simplified implementation
          const baseUrl = config.baseURL || "http://localhost:3000";
          const callbackUrl = `${baseUrl}/api/auth/sso/callback/${providerId}`;

          // Exchange code for tokens (simplified - use proper OIDC library in production)
          // const tokens = await exchangeCodeForTokens(provider, query.code, callbackUrl);
          // const userInfo = await getUserInfo(provider, tokens.access_token);

          // For now, redirect to sign-in with error message
          // In production, you would:
          // 1. Exchange code for tokens
          // 2. Get user info
          // 3. Create or find user
          // 4. Create session
          // 5. Redirect to app

          return reply.redirect(
            `/auth/sign-in?error=${encodeURIComponent("SSO authentication not fully implemented. Please use email/password sign-in.")}`,
          );
        } catch (error) {
          logger.error({ err: error }, "SSO token exchange error");
          return reply.redirect(
            `/auth/sign-in?error=${encodeURIComponent("Failed to complete SSO authentication")}`,
          );
        }
      }

      // For SAML, process SAML response
      if (provider.type === "saml") {
        // SAML processing would require parsing the SAML response
        // For now, redirect with error
        return reply.redirect(
          `/auth/sign-in?error=${encodeURIComponent("SAML authentication not fully implemented. Please use email/password sign-in.")}`,
        );
      }

      return reply.redirect(
        `/auth/sign-in?error=${encodeURIComponent("Invalid SSO callback")}`,
      );
    },
  );
};

export default ssoAuthRoutes;
