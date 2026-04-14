import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { DEFAULT_ADMIN_EMAIL, IDENTITY_PROVIDER_ID, RouteId } from "@shared";
import { verifyPassword } from "better-auth/crypto";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { betterAuth } from "@/auth";
import { ensureCimdClientRegistered, isCimdClientId } from "@/auth/cimd";
import config from "@/config";
import logger from "@/logging";
import {
  AccountModel,
  AgentModel,
  MemberModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  OrganizationModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import {
  buildOAuthIssuer,
  exchangeIdentityAssertionForAccessToken,
  JWT_BEARER_GRANT_TYPE,
  MCP_RESOURCE_REFERENCE_PREFIX,
} from "@/services/identity-providers/enterprise-managed/authorization";
import { ApiError, constructResponseSchema } from "@/types";
import {
  isLoopbackRedirectUri,
  loopbackRedirectUriMatchesIgnoringPort,
} from "@/utils/network";

const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    method: "GET",
    url: "/api/auth/default-credentials-status",
    schema: {
      operationId: RouteId.GetDefaultCredentialsStatus,
      description: "Get default credentials status",
      tags: ["Auth"],
      response: {
        200: z.object({
          enabled: z.boolean(),
        }),
        500: z.object({
          enabled: z.boolean(),
        }),
      },
    },
    handler: async (_request, reply) => {
      try {
        const { adminDefaultEmail, adminDefaultPassword } = config.auth;

        // Check if admin email from config matches the default
        if (adminDefaultEmail !== DEFAULT_ADMIN_EMAIL) {
          // Custom credentials are configured
          return reply.send({ enabled: false });
        }

        // Check if a user with the default email exists
        const userWithDefaultAdminEmail =
          await UserModel.getUserWithByDefaultEmail();

        if (!userWithDefaultAdminEmail) {
          // Default admin user doesn't exist
          return reply.send({ enabled: false });
        }

        /**
         * Check if the user is using the default password
         * Get the password hash from the account table
         */
        const account = await AccountModel.getByUserId(
          userWithDefaultAdminEmail.id,
        );

        if (!account?.password) {
          // No password set (shouldn't happen for email/password auth)
          return reply.send({ enabled: false });
        }

        // Compare the stored password hash with the default password
        const isDefaultPassword = await verifyPassword({
          password: adminDefaultPassword,
          hash: account.password,
        });

        return reply.send({ enabled: isDefaultPassword });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ enabled: false });
      }
    },
  });

  // Custom handler for remove-member to delete orphaned users
  fastify.route({
    method: "POST",
    url: "/api/auth/organization/remove-member",
    schema: {
      tags: ["Auth"],
    },
    async handler(request, reply) {
      const body = request.body as Record<string, unknown>;
      const memberIdOrEmail =
        (body.memberIdOrEmail as string) ||
        (body.memberIdOrUserId as string) ||
        (body.memberId as string);
      const organizationId =
        (body.organizationId as string) || (body.orgId as string);

      let userId: string | undefined;

      // Capture userId before better-auth deletes the member
      if (memberIdOrEmail) {
        // First try to find by member ID
        const memberToDelete = await MemberModel.getById(memberIdOrEmail);

        if (memberToDelete) {
          userId = memberToDelete.userId;
        } else {
          // Maybe it's an email - try finding by userId + orgId
          const memberByUserId = await MemberModel.getByUserId(
            memberIdOrEmail,
            organizationId,
          );

          if (memberByUserId) {
            userId = memberByUserId.userId;
          }
        }
      }

      // Let better-auth handle the member deletion
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();

      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      });

      const response = await betterAuth.handler(req);

      // After successful member removal, delete user's personal token for this org
      if (response.ok && userId && organizationId) {
        try {
          await UserTokenModel.deleteByUserAndOrg(userId, organizationId);
          logger.info(
            `🔑 Personal token deleted for user ${userId} in org ${organizationId}`,
          );
        } catch (tokenDeleteError) {
          logger.error(
            { err: tokenDeleteError },
            "❌ Failed to delete personal token after member removal:",
          );
        }

        // Check if user should be deleted (no remaining memberships)
        try {
          const hasRemainingMemberships =
            await MemberModel.hasAnyMembership(userId);

          if (!hasRemainingMemberships) {
            await UserModel.delete(userId);
            logger.info(
              `✅ User ${userId} deleted (no remaining organizations)`,
            );
          }
        } catch (userDeleteError) {
          logger.error(
            { err: userDeleteError },
            "❌ Failed to delete user after member removal:",
          );
        }
      }

      reply.status(response.status);

      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });

  // OAuth client info lookup (for consent page to display client name)
  fastify.route({
    method: "GET",
    url: "/api/auth/oauth2/client-info",
    schema: {
      operationId: RouteId.GetOAuthClientInfo,
      description: "Get OAuth client name by client_id",
      tags: ["Auth"],
      querystring: z.object({ client_id: z.string() }),
      response: {
        200: z.object({ client_name: z.string().nullable() }),
      },
    },
    async handler(request, reply) {
      const { client_id } = request.query as { client_id: string };
      const clientName = await OAuthClientModel.getNameByClientId(client_id);
      return reply.send({ client_name: clientName });
    },
  });

  // OAuth 2.1 Authorize — intercept to auto-register CIMD clients.
  // When a URL-formatted client_id arrives, fetch the metadata document
  // and register the client before forwarding to better-auth.
  // This specific route takes priority over the catch-all GET /api/auth/*.
  fastify.route({
    method: "GET",
    url: "/api/auth/oauth2/authorize",
    schema: {
      tags: ["Auth"],
    },
    async handler(request, reply) {
      const query = request.query as Record<string, string>;
      const clientId = query.client_id;

      if (clientId && isCimdClientId(clientId)) {
        try {
          await ensureCimdClientRegistered(clientId);
        } catch (error) {
          logger.warn(
            { err: error, clientId },
            "[auth:oauth2/authorize] CIMD auto-registration failed",
          );
          return reply.status(400).send({
            error: `CIMD registration failed: ${(error as Error).message}`,
          });
        }

        // RFC 8252 Section 7.3: loopback redirect URIs MUST allow any port.
        // CIMD documents contain fixed redirect_uris, but native CLI clients
        // (e.g. Claude Code) start a callback server on an ephemeral port.
        // If the requested redirect_uri is loopback and matches a registered
        // URI except for port, dynamically add it so better-auth's exact
        // match succeeds.
        const redirectUri = query.redirect_uri;
        if (redirectUri && isLoopbackRedirectUri(redirectUri)) {
          const client = await OAuthClientModel.findByClientId(clientId);
          const registered = client?.redirectUris ?? [];
          if (
            !registered.includes(redirectUri) &&
            loopbackRedirectUriMatchesIgnoringPort(redirectUri, registered)
          ) {
            await OAuthClientModel.addRedirectUri(clientId, redirectUri);
            logger.debug(
              { clientId, redirectUri },
              "[auth:oauth2/authorize] Added loopback redirect_uri with ephemeral port (RFC 8252)",
            );
          }
        }
      }

      // Forward to better-auth
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (!value || shouldSkipForwardedAuthHeader(key)) {
          return;
        }
        headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
      });

      const response = await betterAuth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });

  // OAuth 2.1 Token — strip the `resource` parameter before forwarding to
  // better-auth. MCP clients (e.g. Cursor, Claude Code) include `resource`
  // with dynamic per-profile URLs like `/v1/mcp/{profileId}`. better-auth's
  // `validAudiences` only supports exact-match strings so there is no way to
  // whitelist a dynamic path. Stripping `resource` causes better-auth to
  // issue opaque tokens instead of JWTs, which our MCP Gateway token
  // validator already handles.
  //
  // Also handles CIMD: if the client_id is a URL, auto-register the client
  // before forwarding to better-auth (needed for token refresh where the
  // authorize endpoint was not hit first in this server instance).
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/token",
    schema: {
      tags: ["Auth"],
    },
    async handler(request, reply) {
      const body = request.body as Record<string, unknown> | undefined;
      const resource = body?.resource;

      // CIMD: auto-register client if client_id is a URL
      const clientId = body?.client_id as string | undefined;
      if (clientId && isCimdClientId(clientId)) {
        try {
          await ensureCimdClientRegistered(clientId);
        } catch (error) {
          logger.warn(
            { err: error, clientId },
            "[auth:oauth2/token] CIMD auto-registration failed",
          );
          return reply.status(400).send({
            error: `CIMD registration failed: ${(error as Error).message}`,
          });
        }
      }

      if (body?.grant_type === JWT_BEARER_GRANT_TYPE) {
        const { clientId: authenticatedClientId, clientSecret } =
          extractOAuthClientCredentials({
            authorizationHeader: request.headers.authorization,
            body,
          });

        const result = await exchangeIdentityAssertionForAccessToken({
          assertion: body.assertion as string | undefined,
          clientId: authenticatedClientId,
          clientSecret,
        });

        return reply
          .status(result.ok ? 200 : result.statusCode)
          .send(result.body);
      }

      if (body?.resource) {
        logger.debug(
          { resource: body.resource },
          "[auth:oauth2/token] Stripping resource parameter from token request",
        );
        delete body.resource;
      }

      const tokenEndpointOrigin = getRequestOrigin({
        protocol: request.protocol,
        headers: request.headers,
      });
      const url = new URL(request.url, tokenEndpointOrigin);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const contentType = request.headers["content-type"] || "";
      const serializedBody = contentType.includes(
        "application/x-www-form-urlencoded",
      )
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body);

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: serializedBody,
      });

      const response = await betterAuth.handler(req);
      const responseBody = await applyMcpOauthTokenLifetimeToResponse({
        response,
        resource,
        tokenEndpointOrigin,
      });

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        if (key.toLowerCase() === "content-length") {
          return;
        }
        reply.header(key, value);
      });
      reply.send(responseBody);
    },
  });

  // OAuth 2.1 Consent — intercept better-auth redirect and return JSON
  // Browser fetch with redirect:"manual" produces opaque redirect responses
  // where Location header is inaccessible. Convert redirect to JSON so the
  // consent form can read the URL and navigate.
  //
  // CSRF protection is handled by better-auth internally:
  //   1. Origin header validation against `trustedOrigins` config
  //   2. The `oauth_query` contains a cryptographically-signed state parameter
  //      that better-auth verifies, preventing replay and tampering
  //   3. Session cookie ties consent to the authenticated user
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/consent",
    schema: {
      operationId: RouteId.SubmitOAuthConsent,
      description: "Submit OAuth consent decision (accept or deny)",
      tags: ["Auth"],
      body: z.object({
        accept: z.boolean(),
        scope: z.string(),
        oauth_query: z.string(),
      }),
      response: constructResponseSchema(z.object({ redirectTo: z.string() })),
    },
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      });

      const response = await betterAuth.handler(req);

      // Forward any set-cookie headers from better-auth
      response.headers.forEach((value: string, key: string) => {
        if (key.toLowerCase() === "set-cookie") {
          reply.header(key, value);
        }
      });

      // Convert HTTP redirect to JSON so the consent form can navigate
      if (response.status === 302 || response.status === 301) {
        const location = response.headers.get("location");
        if (location) {
          return reply.send({ redirectTo: location });
        }
      }

      // better-auth may return 200 JSON with { redirect: true, url/uri }
      // instead of an HTTP redirect. Normalize to { redirectTo } for the frontend.
      // Note: better-auth renamed the field from "uri" to "url" in 1.4.19.
      if (response.ok && response.body) {
        const body = await response.json().catch(() => null);
        const redirectTarget = body?.url || body?.uri;
        if (redirectTarget) {
          return reply.send({ redirectTo: redirectTarget });
        }
      }

      if (!response.ok) {
        throw new ApiError(
          response.status,
          response.body
            ? await response.text()
            : "OAuth consent request failed",
        );
      }

      throw new ApiError(
        500,
        "OAuth consent response did not include a redirect",
      );
    },
  });

  // OAuth 2.1 Dynamic Client Registration (RFC 7591)
  //
  // IMPORTANT: All dynamically registered clients are forced to public
  // (token_endpoint_auth_method = "none"), regardless of what the client
  // sends. This is intentional:
  //   - MCP OAuth spec requires PKCE, not client_secret
  //   - better-auth only allows unauthenticated DCR for public clients
  //   - Some clients (e.g. Open WebUI) send client_secret_post which would
  //     cause registration to fail without this override
  fastify.route({
    method: "POST",
    url: "/api/auth/oauth2/register",
    schema: {
      tags: ["Auth"],
      body: z.record(z.string(), z.unknown()),
    },
    async handler(request, reply) {
      const body = request.body;
      // Override any client-provided value — see route comment above
      body.token_endpoint_auth_method = "none";

      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(body),
      });

      const response = await betterAuth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });

  fastify.route({
    method: "POST",
    url: "/api/auth/sign-in/sso",
    schema: {
      tags: ["Auth"],
    },
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();

      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
      });

      const response = await rewriteGoogleSsoResponseWithHostedDomainHint({
        response: await betterAuth.handler(req),
        requestBody: request.body as Record<string, unknown> | undefined,
      });

      reply.status(response.status);
      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });

  // Existing auth handler for all other auth routes
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    schema: {
      tags: ["Auth"],
    },
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = new Headers();

      Object.entries(request.headers).forEach(([key, value]) => {
        if (value) headers.append(key, value.toString());
      });

      // Handle body based on content type
      // SAML callbacks use application/x-www-form-urlencoded
      let body: string | undefined;
      if (request.body) {
        const contentType = request.headers["content-type"] || "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          // Form-urlencoded body (used by SAML callbacks)
          body = new URLSearchParams(
            request.body as Record<string, string>,
          ).toString();
        } else {
          // JSON body (default)
          body = JSON.stringify(request.body);
        }
      }

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body,
      });

      const response = await betterAuth.handler(req);

      // Check for "Invalid origin" errors and enhance with helpful guidance
      if (response.status === 403 && response.body) {
        const responseText = await response.text();
        if (responseText.includes("Invalid origin")) {
          const requestOrigin = request.headers.origin || "unknown";
          logger.warn(
            {
              origin: requestOrigin,
              trustedOrigins: config.auth.trustedOrigins,
            },
            `Origin "${requestOrigin}" is not trusted. Set ARCHESTRA_FRONTEND_URL or ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS to allow it.`,
          );

          reply.status(403);
          response.headers.forEach((value: string, key: string) => {
            reply.header(key, value);
          });
          return reply.send(
            JSON.stringify({
              message: `Invalid origin: ${requestOrigin} is not in the list of trusted origins. Set ARCHESTRA_FRONTEND_URL=${requestOrigin} or add it to ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS.`,
              trustedOrigins: config.auth.trustedOrigins,
            }),
          );
        }

        // Not an origin error — forward the already-consumed body
        reply.status(response.status);
        response.headers.forEach((value: string, key: string) => {
          reply.header(key, value);
        });
        return reply.send(responseText);
      }

      reply.status(response.status);

      response.headers.forEach((value: string, key: string) => {
        reply.header(key, value);
      });

      reply.send(response.body ? await response.text() : null);
    },
  });
};

export default authRoutes;

async function rewriteGoogleSsoResponseWithHostedDomainHint(params: {
  requestBody?: Record<string, unknown>;
  response: Response;
}): Promise<Response> {
  const providerId = params.requestBody?.providerId;
  if (providerId !== IDENTITY_PROVIDER_ID.GOOGLE) {
    return params.response;
  }

  const hostedDomainHint = await getGoogleHostedDomainHint();
  if (!hostedDomainHint) {
    return params.response;
  }

  const responseText = params.response.body
    ? await params.response.text()
    : undefined;
  if (!responseText) {
    return params.response;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    return new Response(responseText, {
      status: params.response.status,
      statusText: params.response.statusText,
      headers: params.response.headers,
    });
  }

  const headers = new Headers(params.response.headers);
  headers.delete("content-length");

  const location = headers.get("location");
  if (location) {
    headers.set("location", appendHostedDomainHint(location, hostedDomainHint));
  }

  if (typeof payload.url === "string") {
    payload.url = appendHostedDomainHint(payload.url, hostedDomainHint);
  }

  return new Response(JSON.stringify(payload), {
    status: params.response.status,
    statusText: params.response.statusText,
    headers,
  });
}

async function getGoogleHostedDomainHint(): Promise<string | undefined> {
  if (!config.enterpriseFeatures.core) {
    return undefined;
  }

  const { default: IdentityProviderModel } = await import(
    // biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
    "@/models/identity-provider.ee"
  );
  const provider = await IdentityProviderModel.findByProviderId(
    IDENTITY_PROVIDER_ID.GOOGLE,
  );

  return provider?.oidcConfig?.hd?.trim() || undefined;
}

function appendHostedDomainHint(urlString: string, hostedDomainHint: string) {
  const url = new URL(urlString);
  url.searchParams.set("hd", hostedDomainHint);
  return url.toString();
}

function extractOAuthClientCredentials(params: {
  authorizationHeader: string | string[] | undefined;
  body: Record<string, unknown> | undefined;
}): { clientId: string | undefined; clientSecret: string | undefined } {
  const authHeader = Array.isArray(params.authorizationHeader)
    ? params.authorizationHeader[0]
    : params.authorizationHeader;
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64")
        .toString("utf8")
        .split(":");
      const [clientId, ...secretParts] = decoded;
      return {
        clientId,
        clientSecret: secretParts.join(":") || undefined,
      };
    } catch {
      return {
        clientId: undefined,
        clientSecret: undefined,
      };
    }
  }

  return {
    clientId: params.body?.client_id as string | undefined,
    clientSecret: params.body?.client_secret as string | undefined,
  };
}

function shouldSkipForwardedAuthHeader(headerName: string): boolean {
  const normalizedHeaderName = headerName.toLowerCase();
  return (
    normalizedHeaderName === "content-length" ||
    normalizedHeaderName === "host" ||
    normalizedHeaderName === "connection" ||
    normalizedHeaderName === "transfer-encoding"
  );
}

async function applyMcpOauthTokenLifetimeToResponse(params: {
  response: Response;
  resource: unknown;
  tokenEndpointOrigin: string;
}): Promise<string | null> {
  if (!params.response.body) {
    return null;
  }

  const responseText = await params.response.text();
  if (!params.response.ok) {
    return responseText;
  }

  const tokenBody = parseOAuthTokenResponseBody(responseText);
  if (!tokenBody) {
    return responseText;
  }

  const accessToken =
    typeof tokenBody.access_token === "string" ? tokenBody.access_token : null;
  if (
    !accessToken ||
    !isMcpTokenResponse({ tokenBody, resource: params.resource })
  ) {
    return responseText;
  }

  const tokenHash = hashOAuthAccessTokenForLookup(accessToken);
  const storedToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);
  const lifetimeSeconds = await getMcpOauthAccessTokenLifetimeSeconds({
    resource: params.resource,
    referenceId: storedToken?.referenceId,
    tokenEndpointOrigin: params.tokenEndpointOrigin,
  });
  if (!storedToken || !lifetimeSeconds) {
    return responseText;
  }

  const issuedAtSeconds = getIssuedAtSeconds(tokenBody);
  const expiresAtSeconds = issuedAtSeconds + lifetimeSeconds;
  const updatedToken = await OAuthAccessTokenModel.updateExpiresAtByTokenHash({
    tokenHash,
    expiresAt: new Date(expiresAtSeconds * 1000),
  });
  if (!updatedToken) {
    return responseText;
  }

  return JSON.stringify({
    ...tokenBody,
    expires_in: lifetimeSeconds,
    expires_at: expiresAtSeconds,
  });
}

async function getMcpOauthAccessTokenLifetimeSeconds(params: {
  resource: unknown;
  referenceId: string | null | undefined;
  tokenEndpointOrigin: string;
}): Promise<number | null> {
  const profileId =
    (await getProfileIdFromResource({
      resource: params.resource,
      tokenEndpointOrigin: params.tokenEndpointOrigin,
    })) ?? getProfileIdFromReferenceId(params.referenceId);
  if (!profileId) {
    return null;
  }

  const agent = await AgentModel.findById(profileId);
  if (!agent) {
    return null;
  }

  const organization = await OrganizationModel.getById(agent.organizationId);
  return organization?.mcpOauthAccessTokenLifetimeSeconds ?? null;
}

function parseOAuthTokenResponseBody(
  responseText: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(responseText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isMcpTokenResponse(params: {
  tokenBody: Record<string, unknown>;
  resource: unknown;
}): boolean {
  if (typeof params.resource === "string") {
    return true;
  }

  const scope =
    typeof params.tokenBody.scope === "string" ? params.tokenBody.scope : "";
  return scope.split(/\s+/).includes("mcp");
}

function getIssuedAtSeconds(tokenBody: Record<string, unknown>): number {
  if (
    typeof tokenBody.expires_at === "number" &&
    typeof tokenBody.expires_in === "number"
  ) {
    return tokenBody.expires_at - tokenBody.expires_in;
  }

  return Math.floor(Date.now() / 1000);
}

async function getProfileIdFromResource(params: {
  resource: unknown;
  tokenEndpointOrigin: string;
}): Promise<string | null> {
  if (typeof params.resource !== "string") {
    return null;
  }

  try {
    const resourceUrl = new URL(params.resource);
    const issuerOrigin = new URL(buildOAuthIssuer()).origin;
    const allowedOrigins = new Set([issuerOrigin, params.tokenEndpointOrigin]);
    if (!allowedOrigins.has(resourceUrl.origin)) {
      return null;
    }

    const match = resourceUrl.pathname.match(/^\/v1\/mcp\/([^/]+)$/);
    const idOrSlug = match?.[1] ? decodeURIComponent(match[1]) : null;
    return idOrSlug ? AgentModel.resolveIdFromIdOrSlug(idOrSlug) : null;
  } catch {
    return null;
  }
}

function getProfileIdFromReferenceId(
  referenceId: string | null | undefined,
): string | null {
  if (!referenceId?.startsWith(MCP_RESOURCE_REFERENCE_PREFIX)) {
    return null;
  }

  return referenceId.slice(MCP_RESOURCE_REFERENCE_PREFIX.length) || null;
}

function getRequestOrigin(params: {
  protocol: string;
  headers: IncomingHttpHeaders;
}): string {
  const host = Array.isArray(params.headers.host)
    ? params.headers.host[0]
    : params.headers.host;
  const forwardedProto = getFirstHeaderValue(
    params.headers["x-forwarded-proto"],
  );
  const protocol = (forwardedProto || params.protocol || "http").replace(
    /:$/,
    "",
  );

  return `${protocol}://${host}`;
}

function getFirstHeaderValue(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(",")[0]?.trim() || undefined;
}

function hashOAuthAccessTokenForLookup(oauthAccessToken: string): string {
  // codeql[js/insufficient-password-hash] This hashes a high-entropy OAuth bearer token for lookup, not a user password.
  return createHash("sha256").update(oauthAccessToken).digest("base64url");
}
