import {
  OAUTH_ENDPOINTS,
  OAUTH_GRANT_TYPE,
  OAUTH_SCOPES,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import db, { schema as dbSchema } from "@/database";
import { AgentModel } from "@/models";
import { APP_CONNECTOR_PATH_PREFIX } from "@/services/apps/app-connector-resource";
import { ApiError } from "@/types";
import { getPublicRequestOrigin } from "./request-origin";

/**
 * OAuth 2.1 well-known discovery endpoints.
 *
 * Server-to-server endpoints (token, registration, jwks) use the request Host header
 * so they work from Docker containers (host.docker.internal:9000).
 *
 * The authorization_endpoint uses the frontend base URL (e.g. http://localhost:3000)
 * because it's browser-facing — the browser needs to reach it AND have session cookies
 * available. The frontend's catch-all /api/auth proxy forwards to the backend.
 */
const oauthServerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * RFC 9728 - OAuth Protected Resource Metadata
   * GET /.well-known/oauth-protected-resource/*
   *
   * MCP clients hit this to discover which authorization server protects the resource.
   */
  fastify.get(
    "/.well-known/oauth-protected-resource/*",
    {
      schema: {
        tags: ["OAuth"],
        response: {
          200: z.object({
            resource: z.string(),
            authorization_servers: z.array(z.string()),
            scopes_supported: z.array(z.string()),
            bearer_methods_supported: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const baseUrl = getPublicRequestOrigin(request);

      // Extract the resource path (everything after /.well-known/oauth-protected-resource)
      const resourcePath = request.url.replace(
        "/.well-known/oauth-protected-resource",
        "",
      );

      // An MCP App connector's discovery is dark when the feature is off, so it
      // does not reveal that an app exists.
      if (
        resourcePath.startsWith(APP_CONNECTOR_PATH_PREFIX) &&
        !config.apps.enabled
      ) {
        throw new ApiError(404, "Not found");
      }

      // Check if the profile has an external IdP configured
      const authorizationServers = [baseUrl];
      const profileId = await extractProfileIdFromResourcePath(resourcePath);
      if (profileId) {
        const externalIssuer = await getExternalIdpIssuerForProfile(profileId);
        if (externalIssuer) {
          // Include the external IdP's issuer as an additional authorization server
          authorizationServers.push(externalIssuer);
        }
      }

      reply.type("application/json");
      return {
        resource: `${baseUrl}${resourcePath}`,
        authorization_servers: authorizationServers,
        scopes_supported: ["mcp"],
        bearer_methods_supported: ["header"],
      };
    },
  );

  /**
   * RFC 8414 - OAuth Authorization Server Metadata
   * GET /.well-known/oauth-authorization-server
   *
   * MCP clients hit this to discover OAuth endpoints (authorize, token, register, jwks).
   */
  fastify.get(
    "/.well-known/oauth-authorization-server",
    {
      schema: {
        tags: ["OAuth"],
        response: {
          200: z.object({
            issuer: z.string(),
            authorization_endpoint: z.string(),
            token_endpoint: z.string(),
            // Omitted when dynamic client registration is disabled.
            registration_endpoint: z.string().optional(),
            jwks_uri: z.string(),
            response_types_supported: z.array(z.string()),
            grant_types_supported: z.array(z.string()),
            token_endpoint_auth_methods_supported: z.array(z.string()),
            code_challenge_methods_supported: z.array(z.string()),
            scopes_supported: z.array(z.string()),
            client_id_metadata_document_supported: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const baseUrl = getPublicRequestOrigin(request);

      // authorization_endpoint must be browser-facing (for session cookies).
      // Use the frontend URL so the browser sends its session cookie via
      // the catch-all /api/auth proxy. Server-to-server endpoints use the
      // request Host so Docker containers can reach them directly.
      const browserBaseUrl = config.frontendBaseUrl;

      // The issuer MUST match the JWT "iss" claim exactly. Pydantic's AnyHttpUrl
      // (used by MCP clients like Open WebUI) normalizes URLs by appending a
      // trailing slash when the path is empty. We include the trailing slash so
      // the JWT iss claim, the well-known issuer, and the normalized URL all match.
      const issuer = browserBaseUrl.endsWith("/")
        ? browserBaseUrl
        : `${browserBaseUrl}/`;

      reply.type("application/json");
      return {
        issuer,
        authorization_endpoint: `${browserBaseUrl}${OAUTH_ENDPOINTS.authorize}`,
        token_endpoint: `${baseUrl}${OAUTH_ENDPOINTS.token}`,
        // Only advertise DCR when it is enabled.
        ...(config.auth.dynamicClientRegistrationEnabled
          ? {
              registration_endpoint: `${baseUrl}${OAUTH_ENDPOINTS.register}`,
            }
          : {}),
        jwks_uri: `${baseUrl}${OAUTH_ENDPOINTS.jwks}`,
        response_types_supported: ["code"],
        grant_types_supported: [
          "authorization_code",
          "refresh_token",
          "client_credentials",
          OAUTH_GRANT_TYPE.JwtBearer,
        ],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...OAUTH_SCOPES],
        // CIMD auto-registration is gated behind the same DCR toggle.
        client_id_metadata_document_supported:
          config.auth.dynamicClientRegistrationEnabled,
      };
    },
  );
};

export default oauthServerRoutes;

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Extract profile ID from the resource path (e.g., /v1/mcp/<uuid> or /v1/mcp/<slug>)
 */
async function extractProfileIdFromResourcePath(
  resourcePath: string,
): Promise<string | null> {
  // A shareable-App connector resolves only against Archestra's own
  // authorization server, never a profile's external IdP — so its app id is not
  // an agent id to look up.
  if (resourcePath.startsWith(APP_CONNECTOR_PATH_PREFIX)) {
    return null;
  }
  const segments = resourcePath.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment) return null;
  return AgentModel.resolveIdFromIdOrSlug(lastSegment);
}

/**
 * Get the external IdP issuer URL for a profile, if configured.
 * Returns null if the profile doesn't have an identity provider or if it's not OIDC.
 */
async function getExternalIdpIssuerForProfile(
  profileId: string,
): Promise<string | null> {
  const identityProviderId = await AgentModel.findIdentityProviderId(profileId);
  if (!identityProviderId) return null;

  const [provider] = await db
    .select({ issuer: dbSchema.identityProvidersTable.issuer })
    .from(dbSchema.identityProvidersTable)
    .where(eq(dbSchema.identityProvidersTable.id, identityProviderId));

  return provider?.issuer ?? null;
}
