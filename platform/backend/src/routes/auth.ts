import { randomBytes } from "node:crypto";
import {
  DEFAULT_ADMIN_EMAIL,
  IDENTITY_PROVIDER_ID,
  LLM_OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN_LIFETIME_SECONDS,
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
  MCP_OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN_LIFETIME_SECONDS,
  MCP_OAUTH_CLIENT_ID_PREFIX,
  MCP_OAUTH_CLIENT_REFERENCE_PREFIX,
  OAUTH_GRANT_TYPE,
  RouteId,
} from "@archestra/shared";
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
  AppModel,
  LlmOauthClientModel,
  McpOauthClientModel,
  MemberModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  OAuthRefreshTokenModel,
  OrganizationModel,
  UserModel,
  UserTokenModel,
} from "@/models";
import {
  appConnectorAudienceRef,
  appIdFromConnectorPath,
  connectorResourceUriFromAudienceRef,
  isAppConnectorAudienceRef,
  isConnectorTargetedResource,
  resolveAppConnectorResource,
} from "@/services/apps/app-connector-resource";
import {
  buildOAuthIssuer,
  exchangeIdentityAssertionForAccessToken,
  MCP_RESOURCE_REFERENCE_PREFIX,
} from "@/services/identity-providers/enterprise-managed/authorization";
import { ApiError, constructResponseSchema } from "@/types";
import {
  isLoopbackRedirectUri,
  loopbackRedirectUriMatchesIgnoringPort,
} from "@/utils/network";
import { getPublicRequestOrigin } from "./request-origin";

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
      let resolvedOrganizationId: string | undefined;

      // Capture userId before better-auth deletes the member (needed for
      // token/user cleanup below). Audit is handled in the better-auth afterHook.
      if (memberIdOrEmail) {
        const memberToDelete = await MemberModel.getById(memberIdOrEmail);

        if (memberToDelete) {
          userId = memberToDelete.userId;
          resolvedOrganizationId = memberToDelete.organizationId;
        } else if (organizationId) {
          const memberByUserId = await MemberModel.getByUserId(
            memberIdOrEmail,
            organizationId,
          );
          if (memberByUserId) {
            userId = memberByUserId.userId;
            resolvedOrganizationId = memberByUserId.organizationId;
          }
        }
      }

      // Let better-auth handle the member deletion
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = buildBetterAuthForwardedHeaders(request);

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(request.body),
      });

      const response = await betterAuth.handler(req);

      // After successful member removal, delete user's personal token for this org
      if (response.ok && userId && resolvedOrganizationId) {
        try {
          await UserTokenModel.deleteByUserAndOrg(
            userId,
            resolvedOrganizationId,
          );
          logger.info(
            `🔑 Personal token deleted for user ${userId} in org ${resolvedOrganizationId}`,
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

      logger.info(
        {
          clientId,
          scope: query.scope,
          responseType: query.response_type,
          codeChallengeMethod: query.code_challenge_method,
          redirectUri: query.redirect_uri,
          resource: query.resource,
        },
        "[auth:oauth2/authorize] Authorization request received",
      );

      if (
        clientId &&
        isCimdClientId(clientId) &&
        config.auth.dynamicClientRegistrationEnabled
      ) {
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

      // Per OAuth 2.1, scopes must be declared as supported both during Dynamic Client
      // Registration (DCR) and at the token exchange. Some clients (e.g. Cursor) omit
      // offline_access from the authorization request despite registering it during DCR,
      // which would prevent refresh token issuance. To handle this, we inject offline_access
      // into the authorization request if the client registered it during DCR.
      // We only inject it when the client's DCR registration includes offline_access,
      // because clients that did not advertise it during DCR (e.g. MCP Inspector) will
      // reject the authorization response containing an unexpected scope.
      const currentScopes = url.searchParams.get("scope") ?? "";
      if (clientId && !currentScopes.split(" ").includes("offline_access")) {
        const client = await OAuthClientModel.findByClientId(clientId);
        if (client?.scopes?.includes("offline_access")) {
          const augmentedScopes = currentScopes
            ? `${currentScopes} offline_access`
            : "offline_access";
          url.searchParams.set("scope", augmentedScopes);
          logger.debug(
            { originalScope: currentScopes, augmentedScope: augmentedScopes },
            "[auth:oauth2/authorize] Injected offline_access scope",
          );
        }
      }

      const headers = buildBetterAuthForwardedHeaders(
        request,
        shouldSkipForwardedAuthHeader,
      );

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

      if (body?.grant_type === "refresh_token") {
        logger.info(
          {
            clientId: body?.client_id,
            scope: body?.scope,
            resource,
          },
          "[auth:oauth2/token] Refresh token grant request received",
        );
      } else {
        logger.info(
          {
            grantType: body?.grant_type,
            clientId: body?.client_id,
            scope: body?.scope,
            resource,
            hasCode: !!body?.code,
            hasCodeVerifier: !!body?.code_verifier,
          },
          "[auth:oauth2/token] Token request received",
        );
      }

      // CIMD: auto-register client if client_id is a URL
      const clientId = body?.client_id as string | undefined;
      if (
        clientId &&
        isCimdClientId(clientId) &&
        config.auth.dynamicClientRegistrationEnabled
      ) {
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

      if (body?.grant_type === OAUTH_GRANT_TYPE.JwtBearer) {
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

      if (body?.grant_type === "client_credentials") {
        const { clientId: authenticatedClientId, clientSecret } =
          extractOAuthClientCredentials({
            authorizationHeader: request.headers.authorization,
            body,
          });
        // Route to the right issuer by clientId prefix. MCP gateway clients and
        // LLM proxy clients are both stored in the oauth_client table but issue
        // tokens scoped to different resources.
        const issueAccessToken = authenticatedClientId?.startsWith(
          MCP_OAUTH_CLIENT_ID_PREFIX,
        )
          ? issueMcpOauthClientAccessToken
          : issueLlmOauthClientAccessToken;
        const result = await issueAccessToken({
          clientId: authenticatedClientId,
          clientSecret,
          scope: body.scope as string | undefined,
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

      const tokenEndpointOrigin = getPublicRequestOrigin(request);
      const url = new URL(request.url, tokenEndpointOrigin);
      const headers = buildBetterAuthForwardedHeaders(request);

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
      const rawResponseBody = response.body ? await response.text() : null;

      // Bind a shareable-App connector token to its canonical resource URI
      // (RFC 8707) so it is accepted only at its own connector — before deriving
      // the lifetime below, which follows the bound app's org policy and so needs
      // the binding settled first. Fail closed if an app-connector resource was
      // requested but the binding can't be written, rather than hand back a token
      // that silently 401s.
      if (response.ok) {
        const connectorBinding = await bindAppConnectorTokenAudience({
          resource,
          responseBody: rawResponseBody,
          grantType: body?.grant_type,
          tokenEndpointOrigin,
        });
        if (connectorBinding.status === "error") {
          return reply.status(400).send({
            error: "invalid_target",
            error_description: connectorBinding.message,
          });
        }
      }

      const responseBody = await applyOrganizationOAuthTokenLifetimeToResponse({
        responseText: rawResponseBody,
        ok: response.ok,
        resource,
        tokenEndpointOrigin,
      });

      if (response.ok && responseBody) {
        try {
          const tokenResponse = JSON.parse(responseBody);
          const isRefreshGrant = body?.grant_type === "refresh_token";
          logger.info(
            {
              grantType: body?.grant_type,
              clientId: body?.client_id,
              scope: tokenResponse.scope,
              hasAccessToken: !!tokenResponse.access_token,
              hasRefreshToken: !!tokenResponse.refresh_token,
              expiresIn: tokenResponse.expires_in,
            },
            isRefreshGrant
              ? "[auth:oauth2/token] Refresh token grant successful — new access token issued"
              : "[auth:oauth2/token] Token response issued",
          );
        } catch {
          // not JSON, skip logging
        }
      } else if (!response.ok) {
        logger.warn(
          {
            grantType: body?.grant_type,
            clientId: body?.client_id,
            status: response.status,
          },
          "[auth:oauth2/token] Token request failed",
        );
      }

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
      const headers = buildBetterAuthForwardedHeaders(request);

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

      // When DCR is disabled, only pre-registered OAuth clients may run OAuth
      // flows. Reject self-registration with the RFC 7591 error shape.
      if (!config.auth.dynamicClientRegistrationEnabled) {
        logger.warn(
          { clientName: body.client_name },
          "[auth:oauth2/register] Dynamic client registration is disabled",
        );
        return reply.status(403).send({
          error: "access_denied",
          error_description:
            "Dynamic client registration is disabled on this instance",
        });
      }

      logger.info(
        {
          clientName: body.client_name,
          redirectUris: body.redirect_uris,
          grantTypes: body.grant_types,
          responseTypes: body.response_types,
          scope: body.scope,
          tokenEndpointAuthMethod: body.token_endpoint_auth_method,
        },
        "[auth:oauth2/register] Dynamic client registration request received",
      );

      // Override any client-provided value — see route comment above
      body.token_endpoint_auth_method = "none";

      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = buildBetterAuthForwardedHeaders(request);

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: JSON.stringify(body),
      });

      const response = await betterAuth.handler(req);

      if (response.ok && response.body) {
        const responseText = await response.text();
        try {
          const registrationResponse = JSON.parse(responseText);
          logger.info(
            {
              clientId: registrationResponse.client_id,
              clientName: registrationResponse.client_name,
              grantTypes: registrationResponse.grant_types,
              scope: registrationResponse.scope,
            },
            "[auth:oauth2/register] Dynamic client registration successful",
          );
        } catch {
          // not JSON, skip logging
        }

        reply.status(response.status);
        response.headers.forEach((value: string, key: string) => {
          reply.header(key, value);
        });
        reply.send(responseText);
        return;
      }

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
      const headers = buildBetterAuthForwardedHeaders(request);

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
      const headers = buildBetterAuthForwardedHeaders(request);

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

async function issueLlmOauthClientAccessToken(params: {
  clientId: string | undefined;
  clientSecret: string | undefined;
  scope: string | undefined;
}): Promise<{
  ok: boolean;
  statusCode: number;
  body: Record<string, unknown>;
}> {
  if (!params.clientId || !params.clientSecret) {
    return {
      ok: false,
      statusCode: 401,
      body: { error: "invalid_client" },
    };
  }

  const requestedScopes = params.scope?.split(/\s+/).filter(Boolean) ?? [
    LLM_PROXY_OAUTH_SCOPE,
  ];
  if (!requestedScopes.some((scope) => scope === LLM_PROXY_OAUTH_SCOPE)) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "invalid_scope",
        error_description: `${LLM_PROXY_OAUTH_SCOPE} scope is required`,
      },
    };
  }

  const oauthClient = await LlmOauthClientModel.findClientForCredentials({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!oauthClient) {
    return {
      ok: false,
      statusCode: 401,
      body: { error: "invalid_client" },
    };
  }

  const accessToken = `llm_at_${randomBytes(32).toString("base64url")}`;
  const expiresIn = LLM_OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN_LIFETIME_SECONDS;
  await OAuthAccessTokenModel.createClientCredentialsToken({
    tokenHash: hashOAuthAccessTokenForLookup(accessToken),
    clientId: oauthClient.clientId,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: [LLM_PROXY_OAUTH_SCOPE],
    referenceId: `llm-proxy:${oauthClient.id}`,
  });

  return {
    ok: true,
    statusCode: 200,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: LLM_PROXY_OAUTH_SCOPE,
    },
  };
}

async function issueMcpOauthClientAccessToken(params: {
  clientId: string | undefined;
  clientSecret: string | undefined;
  scope: string | undefined;
}): Promise<{
  ok: boolean;
  statusCode: number;
  body: Record<string, unknown>;
}> {
  if (!params.clientId || !params.clientSecret) {
    return {
      ok: false,
      statusCode: 401,
      body: { error: "invalid_client" },
    };
  }

  const requestedScopes = params.scope?.split(/\s+/).filter(Boolean) ?? [
    MCP_GATEWAY_OAUTH_SCOPE,
  ];
  if (!requestedScopes.some((scope) => scope === MCP_GATEWAY_OAUTH_SCOPE)) {
    return {
      ok: false,
      statusCode: 400,
      body: {
        error: "invalid_scope",
        error_description: `${MCP_GATEWAY_OAUTH_SCOPE} scope is required`,
      },
    };
  }

  const oauthClient = await McpOauthClientModel.findClientForCredentials({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
  });
  if (!oauthClient) {
    return {
      ok: false,
      statusCode: 401,
      body: { error: "invalid_client" },
    };
  }

  // Same storage invariant as the LLM issuer: a high-entropy token returned
  // once to the caller, persisted only as a lookup hash, with a finite
  // client-credentials lifetime. Keep this in sync with
  // issueLlmOauthClientAccessToken if either is refactored.
  const accessToken = `mcp_at_${randomBytes(32).toString("base64url")}`;
  const expiresIn = MCP_OAUTH_CLIENT_CREDENTIALS_ACCESS_TOKEN_LIFETIME_SECONDS;
  await OAuthAccessTokenModel.createClientCredentialsToken({
    tokenHash: hashOAuthAccessTokenForLookup(accessToken),
    clientId: oauthClient.clientId,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes: [MCP_GATEWAY_OAUTH_SCOPE],
    referenceId: `${MCP_OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
  });

  return {
    ok: true,
    statusCode: 200,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: MCP_GATEWAY_OAUTH_SCOPE,
    },
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

/**
 * Build the Headers object forwarded into the better-auth Web `Request`.
 *
 * - Strips any client-supplied `x-archestra-client-ip` and re-injects Fastify's
 *   resolved `request.ip` in its place. This is the only IP header
 *   `resolveAuthClientIp` trusts; without this sanitization any caller could
 *   forge the IP recorded against their own auth audit rows simply by setting
 *   the header themselves.
 * - Skips empty header values.
 * - Skips headers rejected by the optional `skipHeader` predicate (used by
 *   `oauth2/authorize` to drop hop-by-hop headers).
 */
function buildBetterAuthForwardedHeaders(
  request: { headers: Record<string, unknown>; ip?: string | null },
  skipHeader?: (headerName: string) => boolean,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value) continue;
    if (key.toLowerCase() === "x-archestra-client-ip") continue;
    if (skipHeader?.(key)) continue;
    headers.append(key, String(value));
  }
  if (request.ip) {
    headers.set("x-archestra-client-ip", request.ip);
  }
  return headers;
}

async function applyOrganizationOAuthTokenLifetimeToResponse(params: {
  responseText: string | null;
  ok: boolean;
  resource: unknown;
  tokenEndpointOrigin: string;
}): Promise<string | null> {
  const { responseText } = params;
  if (responseText === null) {
    return null;
  }
  if (!params.ok) {
    return responseText;
  }

  const tokenBody = parseOAuthTokenResponseBody(responseText);
  if (!tokenBody) {
    return responseText;
  }

  const accessToken =
    typeof tokenBody.access_token === "string" ? tokenBody.access_token : null;
  if (!accessToken) {
    return responseText;
  }

  const tokenHash = hashOAuthAccessTokenForLookup(accessToken);
  const storedToken = await OAuthAccessTokenModel.getByTokenHash(tokenHash);
  if (!storedToken?.userId) {
    return responseText;
  }

  const lifetimeSeconds = await getOAuthAccessTokenLifetimeSeconds({
    resource: params.resource,
    referenceId: storedToken?.referenceId,
    tokenEndpointOrigin: params.tokenEndpointOrigin,
    userId: storedToken.userId,
  });
  if (!lifetimeSeconds) {
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

/**
 * @public — exercised by auth.test.ts (knip --production ignores tests)
 */
export async function getOAuthAccessTokenLifetimeSeconds(params: {
  resource: unknown;
  referenceId: string | null | undefined;
  tokenEndpointOrigin: string;
  userId: string;
}): Promise<number | null> {
  // A shareable-App connector token is scoped to the app's organization, not the
  // viewer's first membership — resolve the app's org (via the token's bound
  // audience ref, or the requested `resource`) so the token can't outlive the
  // owning org's policy. The token endpoint binds the audience before applying
  // the lifetime, so on both grants the ref identifies the connector here.
  const connectorAppId = resolveConnectorAppId({
    resource: params.resource,
    referenceId: params.referenceId,
    tokenEndpointOrigin: params.tokenEndpointOrigin,
  });
  if (connectorAppId) {
    const app = await AppModel.findById(connectorAppId);
    if (app) {
      const organization = await OrganizationModel.getById(app.organizationId);
      return organization?.oauthAccessTokenLifetimeSeconds ?? null;
    }
  }

  const profileId =
    (await getProfileIdFromResource({
      resource: params.resource,
      tokenEndpointOrigin: params.tokenEndpointOrigin,
    })) ?? getProfileIdFromReferenceId(params.referenceId);
  if (profileId) {
    const agent = await AgentModel.findById(profileId);
    if (agent) {
      const organization = await OrganizationModel.getById(
        agent.organizationId,
      );
      return organization?.oauthAccessTokenLifetimeSeconds ?? null;
    }
  }

  const member = await MemberModel.getFirstMembershipForUser(params.userId);
  if (!member) {
    return null;
  }

  const organization = await OrganizationModel.getById(member.organizationId);
  return organization?.oauthAccessTokenLifetimeSeconds ?? null;
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

/**
 * The app id a connector token is bound to, from its audience ref or — as a
 * fallback — the requested `resource`, else null. The ref is preferred and
 * authoritative: it is the token's actual audience, and better-auth ignores a
 * re-sent `resource` on refresh, so the resource must not drive resolution away
 * from the binding. The ref was written by our own mint and is already trusted;
 * the client-supplied resource only resolves on a trusted origin.
 */
function resolveConnectorAppId(params: {
  resource: unknown;
  referenceId: string | null | undefined;
  tokenEndpointOrigin: string;
}): string | null {
  const allowedOrigins = new Set([
    new URL(buildOAuthIssuer()).origin,
    params.tokenEndpointOrigin,
  ]);
  const canonicalUri =
    connectorResourceUriFromAudienceRef(params.referenceId) ??
    resolveAppConnectorResource(params.resource, allowedOrigins);
  if (!canonicalUri) {
    return null;
  }
  try {
    return appIdFromConnectorPath(new URL(canonicalUri).pathname);
  } catch {
    return null;
  }
}

function hashOAuthAccessTokenForLookup(oauthAccessToken: string): string {
  return OAuthAccessTokenModel.hashTokenForLookup(oauthAccessToken);
}

/**
 * Bind a freshly minted access token to a shareable-App connector resource
 * (RFC 8707), so the connector accepts it only at its own canonical URI. The
 * `resource` parameter is stripped before better-auth (which rejects a dynamic
 * audience), so the binding is stamped here, after mint. On an authorization_code
 * grant the audience is the consented `resource`, and a connector-targeted
 * `resource` that cannot be bound returns `error` (RFC 8707 invalid_target) so
 * the caller fails the request rather than hand back a token that silently 401s.
 * On a refresh_token grant the audience is whatever better-auth inherited from
 * the original grant; the requested `resource` is advisory there and never errors
 * (see {@link bindRefreshedConnectorToken}).
 *
 * @public — exercised by auth.test.ts
 */
export async function bindAppConnectorTokenAudience(params: {
  resource: unknown;
  responseBody: string | null;
  grantType: unknown;
  tokenEndpointOrigin: string;
}): Promise<{ status: "ok" | "skip" } | { status: "error"; message: string }> {
  if (!params.responseBody) {
    return { status: "skip" };
  }
  const tokenBody = parseOAuthTokenResponseBody(params.responseBody);
  const accessToken =
    typeof tokenBody?.access_token === "string" ? tokenBody.access_token : null;
  if (!accessToken) {
    return { status: "skip" };
  }

  const tokenHash = hashOAuthAccessTokenForLookup(accessToken);

  // On a refresh better-auth ignores the requested `resource` and inherits the
  // original grant's audience, so the resource-shape checks below must not run
  // here — erroring on a refresh would strand the token better-auth has already
  // rotated. The inherited binding is authoritative.
  if (params.grantType === "refresh_token") {
    return bindRefreshedConnectorToken({
      tokenHash,
      resource: params.resource,
      tokenEndpointOrigin: params.tokenEndpointOrigin,
    });
  }

  // Initial (authorization_code) grant: the requested `resource` determines a
  // new binding. RFC 8707 permits repeated `resource` parameters, which arrive
  // as an array; a connector token binds to exactly one audience, so a connector
  // named among repeated resources cannot be honored and fails closed rather than
  // fall through to an unbound `mcp` token (which still authenticates the MCP
  // gateway via the user-access path). A lone connector resource always arrives
  // as a string.
  if (Array.isArray(params.resource)) {
    if (params.resource.some(isConnectorTargetedResource)) {
      return {
        status: "error",
        message: "A connector resource must be requested as the sole audience.",
      };
    }
    return { status: "skip" };
  }

  const allowedOrigins = new Set([
    new URL(buildOAuthIssuer()).origin,
    params.tokenEndpointOrigin,
  ]);
  const requestedCanonical = resolveAppConnectorResource(
    params.resource,
    allowedOrigins,
  );
  const requestedRef = requestedCanonical
    ? appConnectorAudienceRef(requestedCanonical)
    : null;

  // A connector-targeted `resource` that did not resolve to a trusted canonical
  // URI (an untrusted origin like https://evil.example.com/api/mcp/app/<id>, or a
  // malformed/sub-path connector URL) fails closed with RFC 8707 invalid_target.
  // Absent or non-connector resources are unaffected (they bind elsewhere or not
  // at all).
  if (!requestedRef && isConnectorTargetedResource(params.resource)) {
    return {
      status: "error",
      message:
        "The requested resource is not a valid connector on this server.",
    };
  }
  if (!requestedRef) {
    return { status: "skip" };
  }
  const bound =
    await OAuthAccessTokenModel.bindReferenceIdByTokenHashWhenUnbound({
      tokenHash,
      referenceId: requestedRef,
    });
  if (!bound) {
    // A prior stamp of the same audience is success (idempotent); any other
    // unbindable state fails closed.
    const existing = await OAuthAccessTokenModel.getByTokenHash(tokenHash);
    if (existing?.referenceId === requestedRef) {
      return { status: "ok" };
    }
    logger.error(
      { requestedRef },
      "[auth:oauth2/token] could not bind app connector token to its resource",
    );
    return {
      status: "error",
      message: "Unable to bind the access token to the requested resource.",
    };
  }
  // Carry the binding onto the refresh token so better-auth inherits it on later
  // refreshes. Best-effort: if it can't be written, a future refresh that omits
  // `resource` yields an unbound token the connector rejects (fail-closed).
  if (bound.refreshId) {
    const carried = await OAuthRefreshTokenModel.bindReferenceIdByIdWhenUnbound(
      {
        id: bound.refreshId,
        referenceId: requestedRef,
      },
    );
    if (!carried) {
      logger.warn(
        { refreshId: bound.refreshId, requestedRef },
        "[auth:oauth2/token] could not carry the connector audience onto the refresh token",
      );
    }
  }
  return { status: "ok" };
}

/**
 * Bind a refreshed token to the connector audience better-auth inherited from
 * the original grant (carried via the refresh token's `referenceId`). The
 * requested `resource` is advisory on refresh: better-auth ignores it and cannot
 * re-target the audience, so a mismatch is logged, never errored — erroring would
 * strand the session better-auth has already rotated (the old refresh token is
 * revoked the moment the new one is minted). Returns `skip` for a non-connector
 * token.
 */
async function bindRefreshedConnectorToken(params: {
  tokenHash: string;
  resource: unknown;
  tokenEndpointOrigin: string;
}): Promise<{ status: "ok" | "skip" }> {
  const refreshed = await OAuthAccessTokenModel.getByTokenHash(
    params.tokenHash,
  );
  let inheritedRef = isAppConnectorAudienceRef(refreshed?.referenceId)
    ? (refreshed?.referenceId ?? null)
    : null;
  if (!inheritedRef && refreshed?.refreshId) {
    const refresh = await OAuthRefreshTokenModel.getById(refreshed.refreshId);
    inheritedRef = isAppConnectorAudienceRef(refresh?.referenceId)
      ? (refresh?.referenceId ?? null)
      : null;
  }
  if (!inheritedRef) {
    return { status: "skip" };
  }

  // Surface a client that asked to re-target a different connector on refresh: it
  // gets the inherited binding regardless, but the discrepancy is worth a log.
  const allowedOrigins = new Set([
    new URL(buildOAuthIssuer()).origin,
    params.tokenEndpointOrigin,
  ]);
  const requestedCanonical = resolveAppConnectorResource(
    params.resource,
    allowedOrigins,
  );
  const requestedRef = requestedCanonical
    ? appConnectorAudienceRef(requestedCanonical)
    : null;
  if (requestedRef && requestedRef !== inheritedRef) {
    logger.warn(
      { requestedRef, inheritedRef },
      "[auth:oauth2/token] refresh requested a different connector audience; honoring the inherited binding",
    );
  }

  // Stamp the access token only if better-auth did not already inherit it. The
  // stamp is a one-shot IS NULL write: a no-op when the row already carries the
  // audience (idempotent success). Unlike the authorization_code path this never
  // fails the request — better-auth has already rotated the refresh token, so
  // erroring would strand the session. But if the row ended up unbound or bound
  // to a different audience (stale/partial write, corruption), the refreshed
  // token would 401 at its connector, so surface that rather than assume success.
  if (refreshed?.referenceId !== inheritedRef) {
    const bound =
      await OAuthAccessTokenModel.bindReferenceIdByTokenHashWhenUnbound({
        tokenHash: params.tokenHash,
        referenceId: inheritedRef,
      });
    if (!bound) {
      const existing = await OAuthAccessTokenModel.getByTokenHash(
        params.tokenHash,
      );
      if (existing?.referenceId !== inheritedRef) {
        logger.error(
          { inheritedRef, existingRef: existing?.referenceId ?? null },
          "[auth:oauth2/token] refreshed token could not inherit its connector audience",
        );
      }
    }
  }
  return { status: "ok" };
}
