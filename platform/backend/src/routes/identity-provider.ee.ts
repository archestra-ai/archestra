import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { auth } from "@/auth/better-auth";
import config from "@/config";
import { IDENTITY_PROVIDERS_API_PREFIX } from "@/constants";
import logger from "@/logging";
import AccountModel from "@/models/account";
import IdentityProviderModel from "@/models/identity-provider.ee";
import {
  ApiError,
  constructResponseSchema,
  InsertIdentityProviderSchema,
  PublicIdentityProviderSchema,
  SelectIdentityProviderSchema,
  UpdateIdentityProviderSchema,
} from "@/types";

const identityProviderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Public endpoint for login page - returns only minimal provider info.
   * Does NOT expose any sensitive configuration data like client secrets.
   * Auth is skipped for this endpoint in middleware.
   */
  fastify.get(
    `${IDENTITY_PROVIDERS_API_PREFIX}/public`,
    {
      schema: {
        operationId: RouteId.GetPublicIdentityProviders,
        description:
          "Get public identity provider list for login page (no secrets exposed)",
        tags: ["Identity Providers"],
        response: constructResponseSchema(
          z.array(PublicIdentityProviderSchema),
        ),
      },
    },
    async (_request, reply) => {
      return reply.send(await IdentityProviderModel.findAllPublic());
    },
  );

  /**
   * Admin endpoint - returns full provider config including secrets.
   * Requires authentication and identityProvider:read permission.
   */
  fastify.get(
    IDENTITY_PROVIDERS_API_PREFIX,
    {
      schema: {
        operationId: RouteId.GetIdentityProviders,
        description:
          "Get all identity providers with full configuration (admin only)",
        tags: ["Identity Providers"],
        response: constructResponseSchema(
          z.array(SelectIdentityProviderSchema),
        ),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await IdentityProviderModel.findAll(organizationId));
    },
  );

  /**
   * Returns the IdP logout URL for the current user's identity provider.
   * Used during sign-out to also terminate the IdP session (RP-Initiated Logout).
   */
  fastify.get(
    `${IDENTITY_PROVIDERS_API_PREFIX}/idp-logout-url`,
    {
      schema: {
        operationId: RouteId.GetIdentityProviderIdpLogoutUrl,
        description:
          "Get the IdP logout URL for the current user's identity provider",
        tags: ["Identity Providers"],
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
    `${IDENTITY_PROVIDERS_API_PREFIX}/:id`,
    {
      schema: {
        operationId: RouteId.GetIdentityProvider,
        description: "Get identity provider by ID",
        tags: ["Identity Providers"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(SelectIdentityProviderSchema),
      },
    },
    async ({ params, organizationId }, reply) => {
      const provider = await IdentityProviderModel.findById(
        params.id,
        organizationId,
      );
      if (!provider) {
        throw new ApiError(404, "Identity provider not found");
      }
      return reply.send(provider);
    },
  );

  fastify.post(
    IDENTITY_PROVIDERS_API_PREFIX,
    {
      schema: {
        operationId: RouteId.CreateIdentityProvider,
        description: "Create a new identity provider",
        tags: ["Identity Providers"],
        body: InsertIdentityProviderSchema,
        response: constructResponseSchema(SelectIdentityProviderSchema),
      },
    },
    async ({ body, organizationId, user, headers }, reply) => {
      return reply.send(
        await IdentityProviderModel.create(
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
    `${IDENTITY_PROVIDERS_API_PREFIX}/:id`,
    {
      schema: {
        operationId: RouteId.UpdateIdentityProvider,
        description: "Update identity provider",
        tags: ["Identity Providers"],
        params: z.object({
          id: z.string(),
        }),
        body: UpdateIdentityProviderSchema,
        response: constructResponseSchema(SelectIdentityProviderSchema),
      },
    },
    async ({ params: { id }, body, organizationId }, reply) => {
      const provider = await IdentityProviderModel.update(
        id,
        body,
        organizationId,
      );
      if (!provider) {
        throw new ApiError(404, "Identity provider not found");
      }
      return reply.send(provider);
    },
  );

  fastify.delete(
    `${IDENTITY_PROVIDERS_API_PREFIX}/:id`,
    {
      schema: {
        operationId: RouteId.DeleteIdentityProvider,
        description: "Delete identity provider",
        tags: ["Identity Providers"],
        params: z.object({
          id: z.string(),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params, organizationId }, reply) => {
      const success = await IdentityProviderModel.delete(
        params.id,
        organizationId,
      );
      if (!success) {
        throw new ApiError(404, "Identity provider not found");
      }
      return reply.send({ success: true });
    },
  );
};

export default identityProviderRoutes;

// === Internal helpers ===

export async function getIdpLogoutUrl(userId: string): Promise<string | null> {
  // Find the user's SSO account (non-credential provider)
  const accounts = await AccountModel.getAllByUserId(userId);
  const ssoAccount = accounts.find((a) => a.providerId !== "credential");
  if (!ssoAccount) {
    return null;
  }

  // Find the SSO provider configuration
  const idpProvider = await IdentityProviderModel.findByProviderId(
    ssoAccount.providerId,
  );
  if (!idpProvider?.oidcConfig?.discoveryEndpoint) {
    return null;
  }

  // Fetch the OIDC discovery document to get the end_session_endpoint
  let endSessionEndpoint: string | undefined;
  try {
    const response = await fetch(idpProvider.oidcConfig.discoveryEndpoint, {
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
  if (idpProvider.oidcConfig.clientId) {
    logoutUrl.searchParams.set("client_id", idpProvider.oidcConfig.clientId);
  }
  logoutUrl.searchParams.set(
    "post_logout_redirect_uri",
    `${config.frontendBaseUrl}/auth/sign-in`,
  );
  return logoutUrl.toString();
}
