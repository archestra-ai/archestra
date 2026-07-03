// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  ARCHESTRA_TOKEN_PREFIX,
  AUTO_PROVISIONED_INVITATION_STATUS,
  DEFAULT_APP_NAME,
  emailMatchesAllowedIdentityProviderDomains,
  getEmailDomain,
  IDENTITY_TRUSTED_PROVIDER_IDS,
  OAUTH_PAGES,
  OAUTH_SCOPES,
} from "@archestra/shared";
import {
  allAvailableActions,
  editorPermissions,
  memberPermissions,
} from "@archestra/shared/access-control";
import { apiKey } from "@better-auth/api-key";
import type { HookEndpointContext } from "@better-auth/core";
import { oauthProvider } from "@better-auth/oauth-provider";
import { sso } from "@better-auth/sso";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { admin, jwt, organization, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import config from "@/config";
import db, { schema, withDbTransaction } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { LOG_LEVEL } from "@/logging/log-level";
// Import directly from files to avoid circular dependency through barrel export
import AccountModel from "@/models/account";
import AgentModel from "@/models/agent";
import AuditLogModel from "@/models/audit-log";
import InvitationModel from "@/models/invitation";
import MemberModel from "@/models/member";
import SessionModel from "@/models/session";
import UserModel from "@/models/user";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import type { AuditEventName } from "@/types/audit-log";
import { devAutoLoginPlugin } from "./dev-auto-login";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SSO config is always loaded. The middleware in src/middleware.ts and the
// runtime checks below gate access via enterpriseTier so the small-team free
// tier can enable SSO without the license env var.
// biome-ignore lint/style/noRestrictedImports: dual-licensed at request time
import { ssoConfig, syncSsoRole, syncSsoTeams } from "./idp.ee";
import { linkedIdentityProviderPlugin } from "./linked-idp";
import { hashOauthClientSecret } from "./oauth-client-secret";

// SPDX-SnippetEnd

const APP_NAME = DEFAULT_APP_NAME;
const {
  api: { apiKeyAuthorizationHeaderName },
  frontendBaseUrl,
  auth: { secret, cookieDomain, trustedOrigins: staticTrustedOrigins },
} = config;

const ac = createAccessControl(allAvailableActions);

const adminRole = ac.newRole(allAvailableActions);
const editorRole = ac.newRole(editorPermissions);
const memberRole = ac.newRole(memberPermissions);

export const auth = betterAuth({
  appName: APP_NAME,
  baseURL: frontendBaseUrl,
  secret,
  logger: {
    disabled: LOG_LEVEL === "silent",
    level: getBetterAuthLogLevel(LOG_LEVEL),
    log(level, message, ...args) {
      const formattedMessage = `[Better Auth] ${message}`;
      const payload = args.length > 0 ? { args } : {};

      if (level === "error") {
        logger.error(payload, formattedMessage);
        return;
      }

      if (level === "warn") {
        logger.warn(payload, formattedMessage);
        return;
      }

      logger.info(payload, formattedMessage);
    },
  },
  // Prevent JWT plugin's /token endpoint from conflicting with OAuth provider's /oauth2/token
  disabledPaths: ["/token"],
  ...(config.authRateLimitDisabled ? { rateLimit: { enabled: false } } : {}),
  plugins: [
    organization({
      requireEmailVerificationOnInvitation: false,
      allowUserToCreateOrganization: false, // Disable organization creation by users
      ac,
      dynamicAccessControl: {
        enabled: true,
        /**
         * By default, the maximum number of roles that can be created for an organization is infinite
         * You can also pass a function that returns a number.
         * https://better-auth.com/docs/plugins/organization#maximumrolesperorganization
         */
        // maximumRolesPerOrganization: 50,
        validateRoleName: async (roleName: string) => {
          // Role names must be lowercase alphanumeric with underscores
          if (!/^[a-z0-9_]+$/.test(roleName)) {
            throw new Error(
              "Role name must be lowercase letters, numbers, and underscores only",
            );
          }
          if (roleName.length < 2) {
            throw new Error("Role name must be at least 2 characters");
          }
          if (roleName.length > 50) {
            throw new Error("Role name must be less than 50 characters");
          }
        },
      },
      roles: {
        admin: adminRole,
        editor: editorRole,
        member: memberRole,
      },
      schema: {
        organizationRole: {
          additionalFields: {
            name: {
              type: "string",
              required: true,
            },
            description: {
              type: "string",
              required: false,
            },
          },
        },
      },
      features: {
        team: {
          enabled: true,
          ac,
          roles: {
            admin: adminRole,
            editor: editorRole,
            member: memberRole,
          },
        },
      },
    }),
    admin(),
    // Developer-only auto-login endpoint (self-guards to non-production + env var).
    devAutoLoginPlugin(),
    /**
     * Linked downstream identity provider auth must live inside Better Auth,
     * rather than regular Fastify routes, because completing the flow has to
     * restore the original browser session cookie. Better Auth owns the secure
     * cookie name, signing format, and attributes, and they vary with baseURL
     * and deployment settings.
     */
    linkedIdentityProviderPlugin(),
    apiKey({
      enableSessionForAPIKeys: true,
      apiKeyHeaders: [apiKeyAuthorizationHeaderName],
      defaultPrefix: ARCHESTRA_TOKEN_PREFIX,
      startingCharactersConfig: {
        shouldStore: true,
        // Store enough characters to show `archestra_8594...` style previews.
        charactersLength: 14,
      },
      rateLimit: {
        enabled: false,
      },
      permissions: {
        /**
         * Better Auth applies these defaults to new API keys and uses them
         * when `verifyApiKey` is called with a `permissions` body. Archestra
         * route authorization does not rely on the stored key permissions;
         * API-key requests are checked against the key owner's current RBAC
         * permissions in hasPermission.
         *
         * Docs:
         * - https://better-auth.com/docs/plugins/api-key/reference#permissions
         * - https://better-auth.com/docs/plugins/api-key/advanced#sessions-from-api-keys
         */
        defaultPermissions: allAvailableActions,
      },
    }),
    twoFactor({
      issuer: APP_NAME,
    }),
    ...(ssoConfig ? [sso(ssoConfig)] : []),
    jwt({
      jwt: {
        // Pydantic's AnyHttpUrl (used by MCP/Open WebUI OAuthMetadata model)
        // normalizes URLs by appending a trailing slash when the path is empty.
        // The JWT iss claim must match the normalized issuer from the well-known
        // metadata to pass authlib's claim validation.
        issuer: `${frontendBaseUrl}/`,
      },
      jwks: {
        keyPairConfig: { alg: "RS256", modulusLength: 2048 },
      },
    }),
    oauthProvider({
      loginPage: OAUTH_PAGES.login,
      consentPage: OAUTH_PAGES.consent,
      allowDynamicClientRegistration:
        config.auth.dynamicClientRegistrationEnabled,
      allowUnauthenticatedClientRegistration:
        config.auth.dynamicClientRegistrationEnabled,
      // Confidential MCP OAuth clients (authorization_code grant) are verified by
      // better-auth at the token endpoint. It hashes the presented secret and
      // compares it to the stored value, so the value the McpOauthClient model
      // stores must be exactly this hash.
      storeClientSecret: {
        hash: (clientSecret) => hashOauthClientSecret(clientSecret),
      },
      scopes: [...OAUTH_SCOPES],
      silenceWarnings: {
        oauthAuthServerConfig: true,
        openidConfig: true,
      },
    }),
  ],

  user: {
    deleteUser: {
      enabled: true,
    },
  },

  trustedOrigins: getTrustedOriginsForAuthRequest,

  database: drizzleAdapter(db, {
    provider: "pg", // or "mysql", "sqlite"
    schema: {
      apikey: schema.apikeysTable,
      user: schema.usersTable,
      session: schema.sessionsTable,
      organization: schema.organizationsTable,
      organizationRole: schema.organizationRolesTable,
      member: schema.membersTable,
      invitation: schema.invitationsTable,
      account: schema.accountsTable,
      team: schema.teamsTable,
      teamMember: schema.teamMembersTable,
      twoFactor: schema.twoFactorsTable,
      verification: schema.verificationsTable,
      ssoProvider: schema.identityProvidersTable,
      jwks: schema.jwksTable,
      oauthClient: schema.oauthClientsTable,
      oauthAccessToken: schema.oauthAccessTokensTable,
      oauthRefreshToken: schema.oauthRefreshTokensTable,
      oauthConsent: schema.oauthConsentsTable,
    },
  }),

  emailAndPassword: {
    enabled: true,
  },

  account: {
    /**
     * See better-auth docs here for more information on this:
     * https://www.better-auth.com/docs/reference/options#accountlinking
     */
    accountLinking: {
      enabled: true,
      /**
       * Trust built-in SSO providers plus any identity providers configured by users.
       * This allows existing users to sign in with built-in providers and custom
       * generic OIDC/SAML providers without an env var override.
       */
      trustedProviders: getTrustedAccountLinkingProviderIds,
      /**
       * Don't allow linking accounts with different emails. From the better-auth typescript
       * annotations they mention for this attribute:
       *
       * ⚠️ Warning: enabling allowDifferentEmails might lead to account takeovers
       */
      allowDifferentEmails: false,
      allowUnlinkingAll: true,
    },
  },

  session: {
    // Cache the resolved session in a short-lived signed cookie so the common
    // case — an authenticated API request — can validate the session without a
    // database round-trip. The session table stays the source of truth; the
    // cookie just front-runs the lookup for up to `maxAge` seconds.
    //
    // RBAC role/permission decisions are NOT affected: populateUserInfo still
    // re-reads the user from the database on every request (request.user), so
    // role changes apply immediately. Only session-level facts embedded in the
    // cookie (e.g. a freshly banned user or a revoked session) can lag by up to
    // `maxAge`. 60s is a deliberate trade of that small staleness window for
    // removing a per-request session lookup.
    cookieCache: {
      enabled: true,
      maxAge: 60,
    },
  },

  advanced: {
    cookiePrefix: "archestra",
    defaultCookieAttributes: {
      ...(cookieDomain ? { domain: cookieDomain } : {}),
      // "lax" is required for OAuth/SSO flows because the callback is a cross-site top-level navigation
      // "strict" would prevent the state cookie from being sent with the callback request
      sameSite: "lax",
    },
  },

  databaseHooks: {
    user: {
      delete: {
        before: async (user: { id: string }) => {
          // The agents.author_id FK uses ON DELETE SET NULL so non-personal agents
          // keep their authorship history. Personal MCP gateways must NOT survive
          // the user — the deletion guard in routes/agent.ts blocks DELETE while
          // is_personal_gateway = true, so an orphaned row would be undeletable.
          // Swallow errors so a transient cleanup failure doesn't block the
          // user-deletion flow; an admin can still clean up manually if needed.
          try {
            await AgentModel.deletePersonalMcpGatewaysForUser(user.id);
          } catch (error) {
            logger.error(
              { err: error, userId: user.id },
              "[databaseHooks:user] Failed to delete personal MCP gateways",
            );
          }
          try {
            await AgentModel.deletePersonalLlmProxiesForUser(user.id);
          } catch (error) {
            logger.error(
              { err: error, userId: user.id },
              "[databaseHooks:user] Failed to delete personal LLM proxies",
            );
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          // If activeOrganizationId is not set, find the user's first organization
          if (!session.activeOrganizationId) {
            const membership = await MemberModel.getFirstMembershipForUser(
              session.userId,
            );

            if (membership) {
              logger.info(
                {
                  userId: session.userId,
                  organizationId: membership.organizationId,
                },
                "Auto-setting active organization for new session",
              );
              return {
                data: {
                  ...session,
                  activeOrganizationId: membership.organizationId,
                },
              };
            }
          }
          return { data: session };
        },
      },
    },
    member: {
      create: {
        before: async (member: {
          id: string;
          userId: string;
          organizationId: string;
          role: string;
          createdAt: Date;
        }) => {
          // When a member is created via invitation acceptance, ensure the role
          // matches the invitation's custom role (not better-auth's default)
          try {
            // Use a single JOIN query to find pending invitation for this user
            // This combines user email lookup and invitation lookup into one query
            const [result] = await db
              .select({ invitationRole: schema.invitationsTable.role })
              .from(schema.usersTable)
              .innerJoin(
                schema.invitationsTable,
                and(
                  eq(
                    schema.invitationsTable.email,
                    schema.usersTable.email, // Emails are stored lowercase in both tables
                  ),
                  eq(
                    schema.invitationsTable.organizationId,
                    member.organizationId,
                  ),
                  eq(schema.invitationsTable.status, "pending"),
                ),
              )
              .where(eq(schema.usersTable.id, member.userId))
              .limit(1);

            // No pending invitation found - skip role override
            if (!result) {
              return { data: member };
            }

            if (
              result.invitationRole &&
              result.invitationRole !== member.role
            ) {
              logger.info(
                {
                  userId: member.userId,
                  organizationId: member.organizationId,
                  originalRole: member.role,
                  invitationRole: result.invitationRole,
                },
                "[databaseHooks:member] Overriding role with invitation's custom role",
              );
              return {
                data: {
                  ...member,
                  role: result.invitationRole,
                },
              };
            }
          } catch (error) {
            logger.error(
              { err: error, userId: member.userId },
              "[databaseHooks:member] Error checking invitation role",
            );
          }

          return { data: member };
        },
      },
    },
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => handleBeforeHook(ctx)),
    after: createAuthMiddleware(async (ctx) => handleAfterHook(ctx)),
  },
});

/**
 * Per-request stashes used to ferry data from the `before` hook to the
 * `after` hook (prior member role, removed-member identity, sign-out session).
 *
 * Keyed by the better-auth `Request`. We use WeakMap so that if the `after`
 * hook never fires (client abort, throw inside better-auth, etc.) the stash
 * is reclaimed once the request object is GC'd — no manual cleanup needed.
 */

type SignOutAuditStash = {
  user: { id: string; email: string; name?: string | null };
  session: { id: string; activeOrganizationId?: string | null };
};

const signOutAuditSessionByRequest = new WeakMap<Request, SignOutAuditStash>();

type MemberRoleUpdateStash = {
  memberId: string;
  priorRole: string;
};

const memberRoleUpdateByRequest = new WeakMap<Request, MemberRoleUpdateStash>();

type MemberRemoveStash = {
  memberId: string;
  organizationId: string;
  role: string;
  email: string;
  name: string | null;
};

const memberRemoveByRequest = new WeakMap<Request, MemberRemoveStash>();

function isAuthSignOutPath(path: string | undefined): boolean {
  if (!path) return false;
  const p = path.split("?")[0] ?? path;
  if (p === "/sign-out" || p === "sign-out") return true;
  if (p.endsWith("/sign-out")) return true;
  if (p.includes("/sign-out/")) return true;
  return false;
}

async function stashSignOutSessionForAudit(
  ctx: HookEndpointContext,
): Promise<void> {
  const { path, request, context } = ctx;
  if (!isAuthSignOutPath(path) || !request) return;

  type SessionBundle = {
    user: { id: string; email: string; name?: string | null };
    session: { id: string; activeOrganizationId?: string | null };
  };

  const bundle = context?.session as Partial<SessionBundle> | undefined;
  let user = bundle?.user;
  let session = bundle?.session;

  if (!user || !session) {
    try {
      const headers = new Headers(request.headers as HeadersInit);
      const resolved = await auth.api.getSession({ headers });
      if (resolved?.user && resolved?.session) {
        user = resolved.user as SessionBundle["user"];
        session = resolved.session as SessionBundle["session"];
      }
    } catch (err) {
      logger.debug(
        { err },
        "[auth:audit] sign-out stash: getSession fallback failed",
      );
    }
  }

  if (!user || !session) return;
  signOutAuditSessionByRequest.set(request, { user, session });
}

function consumeStashedSignOutSession(
  request: Request | undefined,
): SignOutAuditStash | undefined {
  if (!request) return undefined;
  const v = signOutAuditSessionByRequest.get(request);
  if (v) signOutAuditSessionByRequest.delete(request);
  return v;
}

function getBetterAuthLogLevel(
  logLevel: string,
): "debug" | "info" | "warn" | "error" | undefined {
  if (logLevel === "trace") {
    return "debug";
  }

  if (logLevel === "fatal") {
    return "error";
  }

  if (
    logLevel === "debug" ||
    logLevel === "info" ||
    logLevel === "warn" ||
    logLevel === "error"
  ) {
    return logLevel;
  }

  return undefined;
}

export type BetterAuth = typeof auth;

/**
 * Better Auth applies `trustedOrigins` to OIDC discovery during SSO provider
 * registration, which means custom IdP setup can fail before the provider is
 * saved unless the discovery origin is already trusted:
 * https://better-auth.com/docs/plugins/sso#trusted-origins
 *
 * Archestra admins are explicitly configuring their own IdPs, so we widen
 * origin trust only for provider registration instead of requiring per-IdP
 * allowlisting. Better Auth also invokes this callback with `request`
 * undefined during internal `auth.api` calls, which is one registration path
 * used by `IdentityProviderModel.create()`. In practice, the same flow can
 * also inherit the outer `/api/identity-providers` request, so that route
 * needs the same treatment during provider creation.
 */
async function getTrustedOriginsForAuthRequest(request?: Request) {
  const trustedOrigins = [...staticTrustedOrigins];

  if (!shouldTrustAllOriginsForIdentityProviderRegistration(request)) {
    return trustedOrigins;
  }

  return [
    ...new Set([
      ...trustedOrigins,
      "http://*:*",
      "https://*:*",
      "http://*",
      "https://*",
    ]),
  ];
}

async function getTrustedAccountLinkingProviderIds(): Promise<string[]> {
  if (!enterpriseTier.isCoreActive()) {
    return [...IDENTITY_TRUSTED_PROVIDER_IDS];
  }

  const { default: IdentityProviderModel } = await import(
    // biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
    "@/models/identity-provider.ee"
  );

  return IdentityProviderModel.getTrustedAccountLinkingProviderIds();
}

/**
 * Keep the wildcard expansion scoped to identity-provider registration so
 * every other auth request still uses the configured trusted origins
 * unchanged.
 */
function shouldTrustAllOriginsForIdentityProviderRegistration(
  request?: Request,
) {
  if (!request) {
    return true;
  }

  try {
    const { pathname } = new URL(request.url);
    return (
      pathname.endsWith("/sso/register") ||
      pathname === "/api/identity-providers"
    );
  } catch {
    return false;
  }
}

/**
 * Validates requests before they are processed by better-auth.
 *
 * Handles:
 * - Blocking invitations when disabled via environment variable
 * - Email validation for invitation requests
 * - Invitation-only sign-up enforcement
 * @public — exported for testability
 */
export async function handleBeforeHook(ctx: HookEndpointContext) {
  const { path, method, body } = ctx;
  const beforeRequest = ctx.request as Request | undefined;

  if (!path) {
    return ctx;
  }

  logger.trace({ path, method }, "[auth:beforeHook] Processing auth request");

  if (isAuthSignOutPath(path)) {
    await stashSignOutSessionForAudit(ctx);
  }

  if (
    path === "/organization/update-member" &&
    method === "POST" &&
    beforeRequest
  ) {
    const memberId = body.memberId as string | undefined;
    if (memberId) {
      const [existing] = await db
        .select({ id: schema.membersTable.id, role: schema.membersTable.role })
        .from(schema.membersTable)
        .where(eq(schema.membersTable.id, memberId))
        .limit(1);
      if (existing) {
        memberRoleUpdateByRequest.set(beforeRequest, {
          memberId,
          priorRole: existing.role,
        });
      }
    }
  }

  if (
    path === "/organization/remove-member" &&
    method === "POST" &&
    beforeRequest
  ) {
    const memberIdOrEmail = body.memberIdOrEmail as string | undefined;
    if (memberIdOrEmail) {
      const [existing] = await db
        .select({
          id: schema.membersTable.id,
          organizationId: schema.membersTable.organizationId,
          role: schema.membersTable.role,
          email: schema.usersTable.email,
          name: schema.usersTable.name,
        })
        .from(schema.membersTable)
        .innerJoin(
          schema.usersTable,
          eq(schema.membersTable.userId, schema.usersTable.id),
        )
        .where(
          memberIdOrEmail.includes("@")
            ? eq(schema.usersTable.email, memberIdOrEmail)
            : eq(schema.membersTable.id, memberIdOrEmail),
        )
        .limit(1);
      if (existing) {
        memberRemoveByRequest.set(beforeRequest, {
          memberId: existing.id,
          organizationId: existing.organizationId,
          role: existing.role,
          email: existing.email,
          name: existing.name ?? null,
        });
      }
    }
  }

  // Block invitation creation when invitations are disabled
  if (path === "/organization/invite-member" && method === "POST") {
    logger.debug(
      { email: body.email, disableInvitations: config.auth.disableInvitations },
      "[auth:beforeHook] Processing invitation request",
    );
    if (config.auth.disableInvitations) {
      logger.debug(
        "[auth:beforeHook] Invitations are disabled, blocking request",
      );
      throw new APIError("FORBIDDEN", {
        message: "User invitations are disabled",
      });
    }

    if (!z.email().safeParse(body.email).success) {
      logger.debug(
        { email: body.email },
        "[auth:beforeHook] Invalid email format",
      );
      throw new APIError("BAD_REQUEST", {
        message: "Invalid email format",
      });
    }

    return ctx;
  }

  // Block invitation cancellation when invitations are disabled
  if (path === "/organization/cancel-invitation" && method === "POST") {
    logger.debug(
      {
        invitationId: body.invitationId,
        disableInvitations: config.auth.disableInvitations,
      },
      "[auth:beforeHook] Processing invitation cancellation",
    );
    if (config.auth.disableInvitations) {
      logger.debug(
        "[auth:beforeHook] Invitations are disabled, blocking cancellation",
      );
      throw new APIError("FORBIDDEN", {
        message: "User invitations are disabled",
      });
    }
  }

  // Block direct sign-up without invitation (invitation-only registration)
  if (path.startsWith("/sign-up/email") && method === "POST") {
    const callbackURL = body.callbackURL as string | undefined;
    const invitationId = getInvitationIdFromSignUpBody(body, callbackURL);

    logger.debug(
      { email: body.email, hasInvitationId: !!invitationId },
      "[auth:beforeHook] Processing sign-up request",
    );

    if (!invitationId) {
      logger.debug("[auth:beforeHook] Sign-up without invitation ID blocked");
      throw new APIError("FORBIDDEN", {
        message:
          "Direct sign-up is disabled. You need an invitation to create an account.",
      });
    }

    // Validate the invitation exists and is pending
    const invitation = await InvitationModel.getById(invitationId);

    if (!invitation) {
      logger.debug({ invitationId }, "[auth:beforeHook] Invitation not found");
      throw new APIError("BAD_REQUEST", {
        message: "Invalid invitation ID",
      });
    }

    const { status, expiresAt } = invitation;
    logger.debug(
      { invitationId, status, expiresAt },
      "[auth:beforeHook] Invitation found, validating",
    );

    if (
      status !== "pending" &&
      !status?.startsWith(AUTO_PROVISIONED_INVITATION_STATUS)
    ) {
      logger.debug(
        { invitationId, status },
        "[auth:beforeHook] Invitation not pending",
      );
      throw new APIError("BAD_REQUEST", {
        message: `This invitation has already been ${status}`,
      });
    }

    // Check if invitation is expired
    if (expiresAt && expiresAt < new Date()) {
      logger.debug(
        { invitationId, expiresAt },
        "[auth:beforeHook] Invitation expired",
      );
      throw new APIError("BAD_REQUEST", {
        message:
          "The invitation link has expired, please contact your admin for a new invitation",
      });
    }

    // Validate email matches invitation
    if (body.email && invitation.email !== body.email) {
      logger.debug(
        { invitationEmail: invitation.email, bodyEmail: body.email },
        "[auth:beforeHook] Email mismatch",
      );
      throw new APIError("BAD_REQUEST", {
        message:
          "Email address does not match the invitation. You must use the invited email address.",
      });
    }

    // Handle auto-provisioned users: they already have a user record but no account.
    // Delete the placeholder user and re-create the invitation as "pending" so
    // better-auth can proceed with normal sign-up (creates fresh user + account).
    if (status?.startsWith(AUTO_PROVISIONED_INVITATION_STATUS)) {
      const [existingUser] = await db
        .select({ id: schema.usersTable.id })
        .from(schema.usersTable)
        .where(eq(schema.usersTable.email, invitation.email))
        .limit(1);

      if (existingUser) {
        // Find another user for inviterId FK (the original will be cascade-deleted)
        const [inviterUser] = await db
          .select({ id: schema.usersTable.id })
          .from(schema.usersTable)
          .where(ne(schema.usersTable.id, existingUser.id))
          .limit(1);

        if (!inviterUser) {
          throw new APIError("BAD_REQUEST", {
            message: "Cannot complete signup",
          });
        }

        logger.info(
          { userId: existingUser.id, email: invitation.email },
          "[auth:beforeHook] Removing auto-provisioned placeholder for sign-up",
        );

        // Save invitation data before cascade delete removes it
        const savedInvitation = {
          id: invitation.id,
          organizationId: invitation.organizationId,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        };

        // Delete placeholder user (cascades to member, invitation, user tokens)
        await db
          .delete(schema.usersTable)
          .where(eq(schema.usersTable.id, existingUser.id));

        // Re-create invitation as "pending" for better-auth's normal sign-up flow
        await db.insert(schema.invitationsTable).values({
          id: savedInvitation.id,
          organizationId: savedInvitation.organizationId,
          email: savedInvitation.email,
          role: savedInvitation.role,
          status: "pending",
          expiresAt: savedInvitation.expiresAt,
          inviterId: inviterUser.id,
        });

        logger.debug(
          { invitationId: savedInvitation.id },
          "[auth:beforeHook] Re-created invitation as pending for sign-up",
        );
      }
    }

    logger.debug(
      { invitationId },
      "[auth:beforeHook] Invitation validated successfully",
    );
    return ctx;
  }

  return ctx;
}

/**
 * Handles post-processing after better-auth operations.
 *
 * Handles:
 * - Deleting canceled invitations
 * - Invalidating sessions when users are deleted
 * - Accepting invitations after sign-up
 * - Auto-accepting pending invitations on sign-in
 * - Setting active organization for new sessions
 * @public — exported for testability
 */
export async function handleAfterHook(ctx: HookEndpointContext) {
  const { path, method, body, context, request } = ctx;

  if (!path) {
    return ctx;
  }

  logger.trace({ path, method }, "[auth:afterHook] Processing post-auth hook");

  // Delete invitation from DB when canceled (instead of marking as canceled)
  if (path === "/organization/cancel-invitation" && method === "POST") {
    const invitationId = body.invitationId as string | undefined;

    if (invitationId) {
      logger.debug(
        { invitationId },
        "[auth:afterHook] Deleting canceled invitation",
      );
      // Capture invitation data before deleting so we can audit it
      let canceledInvitation:
        | Awaited<ReturnType<typeof InvitationModel.getById>>
        | undefined;
      try {
        canceledInvitation = await InvitationModel.getById(invitationId);
      } catch (err) {
        logger.debug(
          { err },
          "[auth:audit] cancel-invitation: failed to fetch invitation for audit",
        );
      }
      try {
        await InvitationModel.delete(invitationId);
        logger.info(`✅ Invitation ${invitationId} deleted from database`);
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to delete invitation:");
      }
      if (canceledInvitation && request) {
        try {
          const headers = new Headers(request.headers as HeadersInit);
          const resolved = await auth.api.getSession({ headers });
          if (resolved?.user && resolved?.session) {
            await AuditLogModel.create({
              organizationId: canceledInvitation.organizationId,
              actorId: resolved.user.id,
              actorType: "user",
              actorName: resolved.user.name ?? null,
              actorEmail: resolved.user.email,
              action: "invitation.deleted",
              outcome: "success",
              resourceType: "invitation",
              resourceId: canceledInvitation.id,
              before: {
                email: canceledInvitation.email,
                role: canceledInvitation.role ?? null,
                status: canceledInvitation.status,
              },
              after: null,
              httpMethod: "POST",
              httpPath: path,
              httpRoute: null,
              httpStatus: null,
              requestId: null,
              sourceIp: resolveAuthClientIp(request),
              userAgent: request.headers.get("user-agent") ?? null,
              occurredAt: new Date(),
            });
          }
        } catch (err) {
          logger.error(
            { err },
            "[auth:audit] failed to write cancel-invitation audit row",
          );
          reportAuditWriteFailure({
            source: "auth",
            resourceType: "invitation",
          });
        }
      }
    }
  }

  // Audit invitation sent
  if (path === "/organization/invite-member" && method === "POST" && request) {
    const email = body.email as string | undefined;
    const role = body.role as string | undefined;
    const orgId = body.organizationId as string | undefined;
    if (email && orgId) {
      try {
        const headers = new Headers(request.headers as HeadersInit);
        const resolved = await auth.api.getSession({ headers });
        if (resolved?.user && resolved?.session) {
          // Find the invitation that was just created so we have its id.
          // The same email may have older canceled/expired rows, so narrow to
          // the org + pending status and prefer the most recent.
          const invitation = await InvitationModel.findByEmail(email).then(
            (rows) =>
              rows
                .filter(
                  (r) => r.organizationId === orgId && r.status === "pending",
                )
                .sort(
                  (a, b) =>
                    (b.createdAt?.getTime() ?? 0) -
                    (a.createdAt?.getTime() ?? 0),
                )[0] ?? null,
          );
          await AuditLogModel.create({
            organizationId: orgId,
            actorId: resolved.user.id,
            actorType: "user",
            actorName: resolved.user.name ?? null,
            actorEmail: resolved.user.email,
            action: "invitation.created",
            outcome: "success",
            resourceType: "invitation",
            resourceId: invitation?.id ?? null,
            before: null,
            after: { email, role: role ?? null },
            httpMethod: "POST",
            httpPath: path,
            httpRoute: null,
            httpStatus: null,
            requestId: null,
            sourceIp: resolveAuthClientIp(request),
            userAgent: request.headers.get("user-agent") ?? null,
            occurredAt: new Date(),
          });
        }
      } catch (err) {
        logger.error(
          { err },
          "[auth:audit] failed to write invite-member audit row",
        );
        reportAuditWriteFailure({ source: "auth", resourceType: "invitation" });
      }
    }
  }

  // Audit invitation accepted by an already-authenticated user
  if (
    path === "/organization/accept-invitation" &&
    method === "POST" &&
    request
  ) {
    const invitationId = body.invitationId as string | undefined;
    if (invitationId) {
      try {
        const headers = new Headers(request.headers as HeadersInit);
        const resolved = await auth.api.getSession({ headers });
        if (resolved?.user && resolved?.session) {
          const invitation = await InvitationModel.getById(invitationId);
          if (invitation) {
            await AuditLogModel.create({
              organizationId: invitation.organizationId,
              actorId: resolved.user.id,
              actorType: "user",
              actorName: resolved.user.name ?? null,
              actorEmail: resolved.user.email,
              action: "member.created",
              outcome: "success",
              resourceType: "member",
              resourceId: invitationId,
              before: null,
              after: {
                email: invitation.email,
                role: invitation.role ?? null,
                invitationId,
              },
              httpMethod: "POST",
              httpPath: path,
              httpRoute: null,
              httpStatus: null,
              requestId: null,
              sourceIp: resolveAuthClientIp(request),
              userAgent: request.headers.get("user-agent") ?? null,
              occurredAt: new Date(),
            });
          }
        }
      } catch (err) {
        logger.error(
          { err },
          "[auth:audit] failed to write accept-invitation audit row",
        );
        reportAuditWriteFailure({ source: "auth", resourceType: "member" });
      }
    }
  }

  // Audit member role changes
  if (path === "/organization/update-member" && method === "POST" && request) {
    const stash = memberRoleUpdateByRequest.get(request);
    memberRoleUpdateByRequest.delete(request);
    const newRole = body.role as string | undefined;
    if (stash && newRole && stash.priorRole !== newRole) {
      try {
        const headers = new Headers(request.headers as HeadersInit);
        const resolved = await auth.api.getSession({ headers });
        if (resolved?.user && resolved?.session) {
          const [member] = await db
            .select({
              userId: schema.membersTable.userId,
              organizationId: schema.membersTable.organizationId,
            })
            .from(schema.membersTable)
            .where(eq(schema.membersTable.id, stash.memberId))
            .limit(1);
          if (member) {
            await AuditLogModel.create({
              organizationId: member.organizationId,
              actorId: resolved.user.id,
              actorType: "user",
              actorName: resolved.user.name ?? null,
              actorEmail: resolved.user.email,
              action: "member.role_updated",
              outcome: "success",
              resourceType: "member",
              resourceId: stash.memberId,
              before: { role: stash.priorRole },
              after: { role: newRole },
              httpMethod: "POST",
              httpPath: path,
              httpRoute: null,
              httpStatus: null,
              requestId: null,
              sourceIp: resolveAuthClientIp(request),
              userAgent: request.headers.get("user-agent") ?? null,
              occurredAt: new Date(),
            });
          }
        }
      } catch (err) {
        logger.error(
          { err },
          "[auth:audit] failed to write member role update audit row",
        );
        reportAuditWriteFailure({ source: "auth", resourceType: "member" });
      }
    }
  }

  // Audit member removal
  if (path === "/organization/remove-member" && method === "POST" && request) {
    const stash = memberRemoveByRequest.get(request);
    memberRemoveByRequest.delete(request);
    if (stash) {
      try {
        const headers = new Headers(request.headers as HeadersInit);
        const resolved = await auth.api.getSession({ headers });
        if (resolved?.user && resolved?.session) {
          await AuditLogModel.create({
            organizationId: stash.organizationId,
            actorId: resolved.user.id,
            actorType: "user",
            actorName: resolved.user.name ?? null,
            actorEmail: resolved.user.email,
            action: "member.deleted",
            outcome: "success",
            resourceType: "member",
            resourceId: stash.memberId,
            before: {
              email: stash.email,
              name: stash.name,
              role: stash.role,
            },
            after: null,
            httpMethod: "POST",
            httpPath: path,
            httpRoute: null,
            httpStatus: null,
            requestId: null,
            sourceIp: resolveAuthClientIp(request),
            userAgent: request.headers.get("user-agent") ?? null,
            occurredAt: new Date(),
          });
        }
      } catch (err) {
        logger.error(
          { err },
          "[auth:audit] failed to write remove-member audit row",
        );
        reportAuditWriteFailure({ source: "auth", resourceType: "member" });
      }
    }
  }

  // Invalidate all sessions when user is deleted
  if (path === "/admin/remove-user" && method === "POST") {
    const userId = body.userId as string | undefined;

    if (userId) {
      // Delete all sessions for this user
      logger.debug(
        { userId },
        "[auth:afterHook] Invalidating all sessions for removed user",
      );
      try {
        await SessionModel.deleteAllByUserId(userId);
        logger.info(`✅ All sessions for user ${userId} invalidated`);
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to invalidate user sessions:");
      }
    }
  }

  // NOTE: User deletion on member removal is handled in routes/auth.ts
  // Better-auth handles member deletion, we just clean up orphaned users

  // Capture sign-out audit event (session is often cleared before/without
  // reliable context in the after hook — see stashSignOutSessionForAudit).
  if (isAuthSignOutPath(path)) {
    const fromBefore = consumeStashedSignOutSession(request);
    if (fromBefore) {
      void writeAuthAuditLog({
        user: fromBefore.user,
        session: fromBefore.session,
        action: "auth.signed_out",
        path,
        request,
      }).catch((err) =>
        logger.error(
          { err },
          "[auth:audit] failed to write sign-out audit row (pre-hook capture)",
        ),
      );
      return ctx;
    }

    const sessionCtx = context?.session as
      | {
          user?: { id: string; email: string; name?: string | null };
          session?: { id: string; activeOrganizationId?: string | null };
        }
      | undefined;
    if (sessionCtx?.user && sessionCtx?.session) {
      void writeAuthAuditLog({
        user: sessionCtx.user,
        session: sessionCtx.session,
        action: "auth.signed_out",
        path,
        request,
      }).catch((err) =>
        logger.error(
          { err },
          "[auth:audit] failed to write sign-out audit row",
        ),
      );
    } else {
      // better-auth may not always populate context.session on sign-out
      // (e.g. revoke-session or token-based flows).  Try to resolve the
      // actor from the incoming request headers so we still capture the event.
      logger.debug(
        { path, hasContext: !!context, hasSession: !!sessionCtx },
        "[auth:afterHook] sign-out: context.session not populated, attempting header-based resolution",
      );
      try {
        const headers = new Headers(
          request?.headers as HeadersInit | undefined,
        );
        const resolved = await auth.api.getSession({ headers });
        if (resolved?.user && resolved?.session) {
          void writeAuthAuditLog({
            user: resolved.user,
            session: resolved.session,
            action: "auth.signed_out",
            path,
            request,
          }).catch((err) =>
            logger.error(
              { err },
              "[auth:audit] failed to write sign-out audit row (fallback)",
            ),
          );
        } else {
          logger.debug(
            "[auth:afterHook] sign-out: could not resolve session from headers either, skipping audit",
          );
        }
      } catch (err) {
        logger.debug(
          { err },
          "[auth:afterHook] sign-out: header-based session resolution failed, skipping audit",
        );
      }
    }
    return ctx;
  }

  if (path.startsWith("/sign-up")) {
    const newSession = context?.newSession;

    if (newSession) {
      const { user, session } = newSession;

      logger.debug(
        { userId: user.id, email: user.email },
        "[auth:afterHook] Processing sign-up completion",
      );

      // Check if this is an invitation sign-up
      const callbackURL = body.callbackURL as string | undefined;
      const invitationId = getInvitationIdFromSignUpBody(body, callbackURL);

      if (invitationId) {
        logger.debug(
          { invitationId, userId: user.id },
          "[auth:afterHook] Accepting invitation after sign-up",
        );
        // Accept first so the membership row exists when writeAuthAuditLog
        // falls back to MemberModel.getFirstMembershipForUser for the org.
        await InvitationModel.accept(session, user, invitationId);
      } else {
        logger.debug(
          { userId: user.id },
          "[auth:afterHook] Direct sign-up (no invitation id)",
        );
      }

      // Audit every completed sign-up (invitation-based or direct).  For
      // direct sign-ups the org resolves via getFirstMembershipForUser inside
      // writeAuthAuditLog; if the user has no membership yet the audit row
      // is skipped (logged as debug) instead of throwing.
      void writeAuthAuditLog({
        user,
        session,
        action: "auth.signed_up",
        path,
        request,
      }).catch((err) =>
        logger.error({ err }, "[auth:audit] failed to write sign-up audit row"),
      );
      return;
    }
  }

  // Handle both regular sign-in and SSO callback
  if (path.startsWith("/sign-in") || path.startsWith("/sso/callback")) {
    const newSession = context?.newSession;

    if (newSession?.user && newSession?.session) {
      const sessionId = newSession.session.id;
      const userId = newSession.user.id;
      const { user, session } = newSession;

      logger.debug(
        { userId, email: user.email, path },
        "[auth:afterHook] Processing sign-in/SSO callback",
      );

      const providerIdHint = path.startsWith("/sso/callback")
        ? getSsoCallbackProviderId({
            path,
            requestUrl: request?.url,
          })
        : undefined;

      if (providerIdHint) {
        await assertSsoEmailDomainAllowed({
          providerId: providerIdHint,
          userEmail: user.email,
          userId,
          sessionId,
        });
      }

      // Audit: successful sign-in or SSO callback (fires after domain check so
      // rejected SSO logins that throw above never produce a row)
      const authAction: AuditEventName = path.startsWith("/sso/callback")
        ? "auth.sso_callback"
        : "auth.signed_in";
      void writeAuthAuditLog({
        user,
        session,
        action: authAction,
        path,
        request,
        ...(providerIdHint ? { providerId: providerIdHint } : {}),
      }).catch((err) =>
        logger.error({ err }, "[auth:audit] failed to write sign-in audit row"),
      );

      // Auto-accept any pending invitations for this user's email
      try {
        const pendingInvitation = await InvitationModel.findPendingByEmail(
          user.email,
        );

        if (pendingInvitation) {
          logger.info(
            `🔗 Auto-accepting pending invitation ${pendingInvitation.id} for user ${user.email}`,
          );
          await InvitationModel.accept(session, user, pendingInvitation.id);
          return;
        }
        logger.debug(
          { email: user.email },
          "[auth:afterHook] No pending invitation found for user",
        );
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to auto-accept invitation:");
      }

      try {
        if (!newSession.session.activeOrganizationId) {
          logger.debug(
            { userId },
            "[auth:afterHook] No active organization, looking up first membership",
          );
          const userMembership =
            await MemberModel.getFirstMembershipForUser(userId);

          if (userMembership) {
            logger.debug(
              { userId, organizationId: userMembership.organizationId },
              "[auth:afterHook] Setting active organization from membership",
            );
            await SessionModel.patch(sessionId, {
              activeOrganizationId: userMembership.organizationId,
            });

            logger.info(
              `✅ Active organization set for user ${newSession.user.email}`,
            );
          } else {
            logger.debug(
              { userId },
              "[auth:afterHook] No membership found for user",
            );
          }
        }
      } catch (error) {
        logger.error({ err: error }, "❌ Failed to set active organization:");
      }

      // Ensure user has a personal default chat agent (idempotent)
      const orgId =
        newSession.session.activeOrganizationId ||
        (await MemberModel.getFirstMembershipForUser(userId))?.organizationId;
      if (orgId) {
        try {
          await AgentModel.ensurePersonalChatAgent({
            userId,
            organizationId: orgId,
          });
        } catch (error) {
          logger.error(
            { err: error },
            "Failed to ensure personal chat agent on sign-in",
          );
        }
        try {
          await AgentModel.ensurePersonalMcpGateway({
            userId,
            organizationId: orgId,
          });
        } catch (error) {
          logger.error(
            { err: error },
            "Failed to ensure personal MCP gateway on sign-in",
          );
        }
        try {
          await AgentModel.ensurePersonalLlmProxy({
            userId,
            organizationId: orgId,
          });
        } catch (error) {
          logger.error(
            { err: error },
            "Failed to ensure personal LLM proxy on sign-in",
          );
        }
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // SSO Role & Team Sync: Synchronize role and team memberships based on SSO claims
      // Only applies to SSO logins (not regular email/password logins)
      if (path.startsWith("/sso/callback")) {
        logger.debug(
          { userId, email: user.email, providerIdHint },
          "[auth:afterHook] Processing SSO role and team sync",
        );

        // Sync role first (based on role mapping rules)
        await syncSsoRole(userId, user.email, providerIdHint);

        // Then sync teams (based on SSO groups)
        await syncSsoTeams(userId, user.email, providerIdHint);
      }
      // SPDX-SnippetEnd
    }
  }
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function getSsoCallbackProviderId(params: {
  path: string;
  requestUrl?: string;
}): string | undefined {
  const callbackPrefix = "/sso/callback/";

  if (params.requestUrl) {
    try {
      const callbackPath = new URL(params.requestUrl).pathname;
      const callbackIndex = callbackPath.indexOf(callbackPrefix);
      if (callbackIndex >= 0) {
        const providerId = callbackPath
          .slice(callbackIndex + callbackPrefix.length)
          .split("/")[0];
        if (providerId) {
          return providerId;
        }
      }
    } catch {
      // Fall back to the normalized route path below.
    }
  }

  if (!params.path.startsWith(callbackPrefix)) {
    return undefined;
  }

  const providerId = params.path.slice(callbackPrefix.length).split("/")[0];
  if (providerId.startsWith(":")) {
    return undefined;
  }

  return providerId || undefined;
}

async function assertSsoEmailDomainAllowed(params: {
  providerId: string;
  userEmail: string;
  userId: string;
  sessionId: string;
}) {
  if (!enterpriseTier.isCoreActive()) {
    return;
  }

  const { default: IdentityProviderModel } = await import(
    // biome-ignore lint/style/noRestrictedImports: runtime-gated EE model import
    "@/models/identity-provider.ee"
  );
  const provider = await IdentityProviderModel.findByProviderId(
    params.providerId,
  );

  if (!provider?.domain) {
    return;
  }

  if (
    emailMatchesAllowedIdentityProviderDomains(
      params.userEmail,
      provider.domain,
    )
  ) {
    return;
  }

  await cleanupRejectedSsoLogin({
    providerId: params.providerId,
    organizationId: provider.organizationId,
    userId: params.userId,
    sessionId: params.sessionId,
  });
  logger.warn(
    {
      providerId: params.providerId,
      emailDomain: getEmailDomain(params.userEmail),
      providerDomain: provider.domain,
    },
    "[auth:afterHook] SSO login denied because user email domain does not match identity provider domain",
  );

  throw new APIError("FORBIDDEN", {
    message: "Your email domain is not allowed for this identity provider.",
  });
}

async function cleanupRejectedSsoLogin(params: {
  providerId: string;
  organizationId: string | null;
  userId: string;
  sessionId: string;
}) {
  await withDbTransaction(async (tx) => {
    await SessionModel.deleteById(params.sessionId, tx);
    await AccountModel.deleteByUserIdAndProviderId({
      userId: params.userId,
      providerId: params.providerId,
      tx,
    });

    const accounts = await AccountModel.getAllByUserId(params.userId, tx);

    if (accounts.length === 0 && params.organizationId) {
      await MemberModel.deleteByMemberOrUserId(
        params.userId,
        params.organizationId,
        tx,
      );
    }

    const hasMembership = await MemberModel.hasAnyMembership(params.userId, tx);

    if (accounts.length === 0 && !hasMembership) {
      await UserModel.delete(params.userId, tx);
    }
  });
}
// SPDX-SnippetEnd

/**
 * Writes a single auth-event row to audit_logs.
 * Always called with `void … .catch(logger.error)` so it never blocks or throws.
 */
async function writeAuthAuditLog(params: {
  user: { id: string; name?: string | null; email: string };
  session: { id: string; activeOrganizationId?: string | null };
  action: AuditEventName;
  path: string;
  request?: Request;
  providerId?: string;
}): Promise<void> {
  const { user, session, action, path, request, providerId } = params;

  const organizationId =
    session.activeOrganizationId ??
    (await MemberModel.getFirstMembershipForUser(user.id))?.organizationId;

  if (!organizationId) {
    logger.debug(
      { userId: user.id, action },
      "[auth:audit] skipping: no organization found for actor",
    );
    return;
  }

  const sourceIp = resolveAuthClientIp(request);
  const userAgent = request?.headers.get("user-agent") ?? null;

  // SSO callbacks are actor_type="sso"; all other auth events are actor_type="user".
  const actorType = action === "auth.sso_callback" ? "sso" : "user";

  let after: Record<string, unknown> | null = null;
  if (action === "auth.signed_in" || action === "auth.sso_callback") {
    after = { sessionId: session.id };
    if (providerId) {
      after.providerId = providerId;
    }
  } else if (action === "auth.signed_out") {
    after = { sessionId: session.id, ended: true };
  } else if (action === "auth.signed_up") {
    after = { sessionId: session.id, userId: user.id };
  }

  try {
    await AuditLogModel.create({
      organizationId,
      actorId: user.id,
      actorType,
      actorName: user.name ?? null,
      actorEmail: user.email,
      action,
      outcome: "success",
      resourceType: "auth",
      resourceId: user.id,
      before: null,
      after,
      httpMethod: "POST",
      httpPath: path,
      httpRoute: null,
      httpStatus: null,
      // better-auth operates on Web Request objects; Fastify's request.id is not
      // accessible here. requestId is null for all auth-surface audit rows.
      requestId: null,
      sourceIp,
      userAgent,
      occurredAt: new Date(),
    });
  } catch (err) {
    reportAuditWriteFailure({ source: "auth", resourceType: "auth" });
    throw err;
  }
}

/**
 * Resolve the client IP for auth audit events. Better-auth hands us a Web
 * `Request` with no socket-level remote address.
 *
 * Priority:
 * 1. `x-archestra-client-ip` — injected by the Fastify auth route handlers
 *    from `request.ip` after stripping any client-supplied copy. When present
 *    this is the most trustworthy source because Fastify has already applied
 *    the `trustProxy` / `ARCHESTRA_TRUST_PROXY` setting.
 * 2. `x-forwarded-for` — forwarded verbatim from the Fastify request. Used as
 *    a fallback for deployments where `socket.remoteAddress` is unavailable
 *    (e.g. Unix-socket listeners) or where `ARCHESTRA_TRUST_PROXY` has not
 *    been configured. Note: without a trusted-proxy config this value can be
 *    set by clients; IPs here are informational and not used for access control.
 */
function resolveAuthClientIp(request: Request | undefined): string | null {
  if (!request) return null;
  const injected = request.headers.get("x-archestra-client-ip");
  if (injected) return injected;
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

function getInvitationIdFromSignUpBody(
  body: Record<string, unknown>,
  callbackURL: string | undefined,
): string | undefined {
  const bodyInvitationId = body.invitationId;
  if (typeof bodyInvitationId === "string" && bodyInvitationId.trim()) {
    return bodyInvitationId.trim();
  }

  if (!callbackURL) {
    return undefined;
  }

  try {
    const url = new URL(callbackURL, "http://localhost");
    return url.searchParams.get("invitationId") ?? undefined;
  } catch {
    return undefined;
  }
}
