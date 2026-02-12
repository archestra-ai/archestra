import { OAUTH_ENDPOINTS, OAUTH_SCOPES } from "@shared";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import db, { schema as dbSchema } from "@/database";
import { UuidIdSchema } from "@/types";

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
        tags: ["oauth"],
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
      const host = request.headers.host;
      const protocol = request.protocol;
      const baseUrl = `${protocol}://${host}`;

      // Extract the resource path (everything after /.well-known/oauth-protected-resource)
      const resourcePath = request.url.replace(
        "/.well-known/oauth-protected-resource",
        "",
      );

      // Check if the profile has an external IdP configured
      const authorizationServers = [baseUrl];
      const profileId = extractProfileIdFromResourcePath(resourcePath);
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
        tags: ["oauth"],
        response: {
          200: z.object({
            issuer: z.string(),
            authorization_endpoint: z.string(),
            token_endpoint: z.string(),
            registration_endpoint: z.string(),
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
      const host = request.headers.host;
      const protocol = request.protocol;
      const baseUrl = `${protocol}://${host}`;

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
        registration_endpoint: `${baseUrl}${OAUTH_ENDPOINTS.register}`,
        jwks_uri: `${baseUrl}${OAUTH_ENDPOINTS.jwks}`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...OAUTH_SCOPES],
        client_id_metadata_document_supported: true,
      };
    },
  );
};

export default oauthServerRoutes;

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Extract profile ID from the resource path (e.g., /v1/mcp/<uuid>)
 */
function extractProfileIdFromResourcePath(resourcePath: string): string | null {
  const segments = resourcePath.split("/").filter(Boolean);
  const lastSegment = segments.at(-1);
  if (!lastSegment) return null;
  try {
    return UuidIdSchema.parse(lastSegment);
  } catch {
    return null;
  }
}

/**
 * Get the external IdP issuer URL for a profile, if configured.
 * Returns null if the profile doesn't have an identity provider or if it's not OIDC.
 */
async function getExternalIdpIssuerForProfile(
  profileId: string,
): Promise<string | null> {
  const [agent] = await db
    .select({ identityProviderId: dbSchema.agentsTable.identityProviderId })
    .from(dbSchema.agentsTable)
    .where(eq(dbSchema.agentsTable.id, profileId));

  if (!agent?.identityProviderId) return null;

  const [provider] = await db
    .select({ issuer: dbSchema.identityProvidersTable.issuer })
    .from(dbSchema.identityProvidersTable)
    .where(eq(dbSchema.identityProvidersTable.id, agent.identityProviderId));

  return provider?.issuer ?? null;
}
