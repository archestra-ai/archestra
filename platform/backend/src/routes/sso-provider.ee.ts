import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "@/auth/better-auth";
import config from "@/config";
import { SSO_PROVIDERS_API_PREFIX } from "@/constants";
import logger from "@/logging";
import AccountModel from "@/models/account";
import SsoProviderModel from "@/models/sso-provider.ee";
import {
  ApiError,
  constructResponseSchema,
  InsertSsoProviderSchema,
  PublicSsoProviderSchema,
  SelectSsoProviderSchema,
  UpdateSsoProviderSchema,
} from "@/types";

const ssoProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Public endpoint for login page - returns only minimal provider info.
   * Does NOT expose any sensitive configuration data like client secrets.
   * Auth is skipped for this endpoint in middleware.
   */
  fastify.get(
    `${SSO_PROVIDERS_API_PREFIX}/public`,
    {
      schema: {
        operationId: RouteId.GetPublicSsoProviders,
        description:
          "Get public SSO provider list for login page (no secrets exposed)",
        tags: ["SSO Providers"],
        response: constructResponseSchema(z.array(PublicSsoProviderSchema)),
      },
    },
    async (_request, reply) => {
      return reply.send(await SsoProviderModel.findAllPublic());
    },
  );

  /**
   * Admin endpoint - returns full provider config including secrets.
   * Requires authentication and ssoProvider:read permission.
   */
  fastify.get(
    SSO_PROVIDERS_API_PREFIX,
    {
      schema: {
        operationId: RouteId.GetSsoProviders,
        description:
          "Get all SSO providers with full configuration (admin only)",
        tags: ["SSO Providers"],
        response: constructResponseSchema(z.array(SelectSsoProviderSchema)),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await SsoProviderModel.findAll(organizationId));
    },
  );

  /**
   * Returns the IdP logout URL for the current user's SSO provider.
   * Used during sign-out to also terminate the IdP session (RP-Initiated Logout).
   */
  fastify.get(
    `${SSO_PROVIDERS_API_PREFIX}/idp-logout-url`,
    {
      schema: {
        operationId: RouteId.GetSsoProviderIdpLogoutUrl,
        description:
          "Get the IdP logout URL for the current user's SSO provider",
        tags: ["SSO Providers"],
        response: constructResponseSchema(
          z.object({ url: z.string().nullable() }),
        ),
      },
    },
    async ({ user }, reply) => {
      const url = await getIdpLogoutUrl(user.id);
      return reply.send({ url });
    },
  );

  fastify.get(
    `${SSO_PROVIDERS_API_PREFIX}/:id`,
    {
      schema: {
        operationId: RouteId.GetSsoProvider,
        description: "Get SSO provider by ID",
        tags: ["SSO Providers"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const provider = await SsoProviderModel.findById(
        params.id,
        organizationId,
      );
      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }
      return reply.send(provider);
    },
  );

  fastify.post(
    SSO_PROVIDERS_API_PREFIX,
    {
      schema: {
        operationId: RouteId.CreateSsoProvider,
        description: "Create a new SSO provider",
        tags: ["SSO Providers"],
        body: InsertSsoProviderSchema,
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ body, organizationId, user, headers }, reply) => {
      return reply.send(
        await SsoProviderModel.create(
          {
            ...body,
            userId: user.id,
          },
          organizationId,
          headers as HeadersInit,
          auth,
        ),
      );
    },
  );

  fastify.put(
    `${SSO_PROVIDERS_API_PREFIX}/:id`,
    {
      schema: {
        operationId: RouteId.UpdateSsoProvider,
        description: "Update SSO provider",
        tags: ["SSO Providers"],
        params: z.object({
          id: z.string(),
        }),
        body: UpdateSsoProviderSchema,
        response: constructResponseSchema(SelectSsoProviderSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const provider = await SsoProviderModel.update(id, body, organizationId);
      if (!provider) {
        throw new ApiError(404, "SSO provider not found");
      }
      return reply.send(provider);
    },
  );

  fastify.delete(
    `${SSO_PROVIDERS_API_PREFIX}/:id`,
    {
      schema: {
        operationId: RouteId.DeleteSsoProvider,
        description: "Delete SSO provider",
        tags: ["SSO Providers"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const success = await SsoProviderModel.delete(params.id, organizationId);
      if (!success) {
        throw new ApiError(404, "SSO provider not found");
      }
      return reply.send({ success: true });
    },
  );
};

export default ssoProviderRoutes;

// === Internal helpers ===

export async function getIdpLogoutUrl(userId: string): Promise<string | null> {
  // Find the user's SSO account (non-credential provider)
  const accounts = await AccountModel.getAllByUserId(userId);
  const ssoAccount = accounts.find((a) => a.providerId !== "credential");
  if (!ssoAccount) {
    return null;
  }

  // Find the SSO provider configuration
  const ssoProvider = await SsoProviderModel.findByProviderId(
    ssoAccount.providerId,
  );
  if (!ssoProvider?.oidcConfig?.discoveryEndpoint) {
    return null;
  }

  // Fetch the OIDC discovery document to get the end_session_endpoint
  let endSessionEndpoint: string | undefined;
  try {
    const response = await fetch(ssoProvider.oidcConfig.discoveryEndpoint, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.warn(
        {
          providerId: ssoAccount.providerId,
          status: response.status,
        },
        "Failed to fetch OIDC discovery document for IdP logout",
      );
      return null;
    }
    const discoveryDoc = (await response.json()) as Record<string, unknown>;
    endSessionEndpoint = discoveryDoc.end_session_endpoint as
      | string
      | undefined;
  } catch (error) {
    logger.warn(
      { err: error, providerId: ssoAccount.providerId },
      "Error fetching OIDC discovery document for IdP logout",
    );
    return null;
  }

  if (!endSessionEndpoint) {
    return null;
  }

  // Construct the logout URL with id_token_hint, client_id, and post_logout_redirect_uri
  const logoutUrl = new URL(endSessionEndpoint);
  if (ssoAccount.idToken) {
    logoutUrl.searchParams.set("id_token_hint", ssoAccount.idToken);
  }
  if (ssoProvider.oidcConfig.clientId) {
    logoutUrl.searchParams.set("client_id", ssoProvider.oidcConfig.clientId);
  }
  logoutUrl.searchParams.set(
    "post_logout_redirect_uri",
    `${config.frontendBaseUrl}/auth/sign-in`,
  );
  return logoutUrl.toString();
}
