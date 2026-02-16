import type { SSOOptions } from "@better-auth/sso";
import type { IdpRoleMappingConfig } from "@shared";
import { MEMBER_ROLE_NAME } from "@shared";
import { APIError } from "better-auth";
import { and, eq } from "drizzle-orm";
import { jwtDecode } from "jwt-decode";
import type { BetterAuth } from "@/auth/better-auth";
import {
  cacheIdpGroups,
  extractGroupsFromClaims,
} from "@/auth/idp-team-sync-cache.ee";
import db, { schema } from "@/database";
import logger from "@/logging";
import { evaluateRoleMappingTemplate } from "@/templating";
import type {
  IdentityProvider,
  InsertIdentityProvider,
  PublicIdentityProvider,
  UpdateIdentityProvider,
} from "@/types";
import AccountModel from "./account";
import MemberModel from "./member";

interface RoleMappingContext {
  token?: Record<string, unknown>;
  provider: {
    id: string;
    providerId: string;
  };
}

interface RoleMappingResult {
  /** The resolved role (or null if strict mode and no match) */
  role: string | null;
  /** Whether a rule explicitly matched */
  matched: boolean;
  /** Error message if login should be denied (strict mode) */
  error?: string;
}

export type IdpGetRoleData = Parameters<
  NonNullable<NonNullable<SSOOptions["organizationProvisioning"]>["getRole"]>
>[0];

class IdentityProviderModel {
  /**
   * Evaluates role mapping rules against SSO user data using Handlebars templates.
   *
   * @example
   * // Map users with "admin" in their groups array to admin role
   * { expression: "{{#includes groups \"admin\"}}true{{/includes}}", role: "admin" }
   *
   * @example
   * // Map users with specific department
   * { expression: "{{#equals department \"Engineering\"}}true{{/equals}}", role: "member" }
   *
   * @example
   * // Map users with specific role in roles array
   * { expression: "{{#each roles}}{{#equals this \"archestra-admin\"}}true{{/equals}}{{/each}}", role: "admin" }
   */
  static evaluateRoleMapping(
    config: IdpRoleMappingConfig | undefined,
    context: RoleMappingContext,
    fallbackRole: string = MEMBER_ROLE_NAME,
  ): RoleMappingResult {
    // No rules configured - use default
    if (!config?.rules?.length) {
      return {
        role: config?.defaultRole || fallbackRole,
        matched: false,
      };
    }

    // Use ID token claims for role mapping
    const data = context.token || {};

    logger.debug(
      { providerId: context.provider.providerId, dataKeys: Object.keys(data) },
      "Evaluating role mapping rules against ID token claims",
    );

    // Evaluate rules in order, first match wins
    for (const rule of config.rules) {
      try {
        // Use Handlebars template evaluation
        const matches = evaluateRoleMappingTemplate(rule.expression, data);

        if (matches) {
          logger.info(
            {
              providerId: context.provider.providerId,
              expression: rule.expression,
              role: rule.role,
            },
            "Role mapping rule matched",
          );
          return {
            role: rule.role,
            matched: true,
          };
        }
      } catch (error) {
        logger.warn(
          {
            err: error,
            providerId: context.provider.providerId,
            expression: rule.expression,
          },
          "Error evaluating role mapping expression",
        );
        // Continue to next rule on error
      }
    }

    // No rules matched - check strict mode
    if (config.strictMode) {
      logger.warn(
        { providerId: context.provider.providerId },
        "Role mapping strict mode enabled and no rules matched - denying login",
      );
      return {
        role: null,
        matched: false,
        error:
          "Access denied: Your account does not match any role mapping rules configured for this identity provider.",
      };
    }

    // Use default role
    const resolvedRole = config.defaultRole || fallbackRole;
    logger.debug(
      { providerId: context.provider.providerId, role: resolvedRole },
      "No role mapping rules matched, using default",
    );

    return {
      role: resolvedRole,
      matched: false,
    };
  }

  /**
   * Dynamic role assignment based on identity provider role mapping configuration.
   * Uses Handlebars templates to evaluate user attributes from the IdP.
   *
   * Supports:
   * - Handlebars-based role mapping rules
   * - Strict mode: Deny login if no rules match
   * - Skip role sync: Only set role on first login
   *
   * @param data - SSO user data from the identity provider
   * @returns The resolved role ("member" | "admin" | custom role)
   * @throws APIError with FORBIDDEN if strict mode is enabled and no rules match
   */
  static async resolveSsoRole(data: IdpGetRoleData): Promise<string> {
    const { user, token, provider } = data;

    logger.debug(
      {
        providerId: provider?.providerId,
        userId: user?.id,
        userEmail: user?.email,
        hasToken: !!token,
        tokenKeys: token ? Object.keys(token) : [],
      },
      "resolveSsoRole: Starting IdP role resolution",
    );

    // Better-auth passes the raw OAuth token response, not decoded JWT claims.
    // We need to decode the idToken to get claims like 'groups' for role mapping.
    const idTokenJwt = token?.idToken;
    let idTokenClaims: Record<string, unknown> | null = null;
    if (idTokenJwt) {
      try {
        idTokenClaims = jwtDecode<Record<string, unknown>>(idTokenJwt);
        logger.debug(
          {
            providerId: provider?.providerId,
            idTokenClaimKeys: Object.keys(idTokenClaims),
            idTokenClaims,
          },
          "resolveSsoRole: Decoded idToken JWT claims",
        );
      } catch (decodeError) {
        logger.warn(
          { err: decodeError, providerId: provider?.providerId },
          "resolveSsoRole: Failed to decode idToken JWT for role mapping",
        );
      }
    } else {
      logger.debug(
        { providerId: provider?.providerId },
        "resolveSsoRole: No idToken JWT present in token response",
      );
    }

    try {
      // Fetch the identity provider configuration to get role mapping rules
      logger.debug(
        { providerId: provider.providerId },
        "resolveSsoRole: Fetching identity provider configuration",
      );
      const idpProvider = await IdentityProviderModel.findByProviderId(
        provider.providerId,
      );

      logger.debug(
        {
          providerId: provider.providerId,
          idpProviderFound: !!idpProvider,
          hasRoleMapping: !!idpProvider?.roleMapping,
          roleMappingConfig: idpProvider?.roleMapping,
          organizationId: idpProvider?.organizationId,
        },
        "resolveSsoRole: Identity provider configuration retrieved",
      );

      if (idpProvider?.roleMapping) {
        const roleMapping = idpProvider.roleMapping;

        // Handle skipRoleSync: If enabled and user already has a membership in this organization, keep their current role
        logger.debug(
          {
            providerId: provider.providerId,
            skipRoleSync: roleMapping.skipRoleSync,
            userId: user?.id,
            organizationId: idpProvider.organizationId,
          },
          "resolveSsoRole: Checking skipRoleSync configuration",
        );

        if (roleMapping.skipRoleSync && user?.id) {
          const existingMember = idpProvider.organizationId
            ? await MemberModel.getByUserId(user.id, idpProvider.organizationId)
            : null;

          logger.debug(
            {
              providerId: provider.providerId,
              userId: user.id,
              existingMemberFound: !!existingMember,
              existingRole: existingMember?.role,
            },
            "resolveSsoRole: skipRoleSync - checked for existing membership",
          );

          if (existingMember) {
            logger.info(
              {
                providerId: provider.providerId,
                userId: user.id,
                organizationId: idpProvider.organizationId,
                currentRole: existingMember.role,
              },
              "Skip role sync enabled - keeping existing role",
            );

            // Cache IdP groups for team sync before returning (even when skipping role sync)
            if (user.email && idpProvider.organizationId) {
              const tokenClaims =
                idTokenClaims || (token as Record<string, unknown>) || {};
              const groups = extractGroupsFromClaims(
                tokenClaims,
                idpProvider.teamSyncConfig,
              );
              if (groups.length > 0) {
                await cacheIdpGroups(
                  provider.providerId,
                  user.email,
                  idpProvider.organizationId,
                  groups,
                );
                logger.debug(
                  {
                    providerId: provider.providerId,
                    email: user.email,
                    groupCount: groups.length,
                  },
                  "Cached IdP groups for team sync (skipRoleSync path)",
                );
              }
            }

            return existingMember.role;
          }
        }

        // Evaluate role mapping rules using ID token claims
        const tokenClaims =
          idTokenClaims || (token as Record<string, unknown>) || {};

        logger.debug(
          {
            providerId: provider.providerId,
            tokenClaimsKeys: Object.keys(tokenClaims),
            tokenClaims,
            roleMapping,
          },
          "resolveSsoRole: Evaluating role mapping rules with token claims",
        );

        const result = IdentityProviderModel.evaluateRoleMapping(
          roleMapping,
          {
            token: tokenClaims,
            provider: {
              id: provider.providerId,
              providerId: provider.providerId,
            },
          },
          MEMBER_ROLE_NAME,
        );

        logger.debug(
          {
            providerId: provider.providerId,
            result,
          },
          "resolveSsoRole: Role mapping evaluation completed",
        );

        // Handle strict mode: Deny login if no rules matched
        if (result.error) {
          logger.warn(
            {
              providerId: provider.providerId,
              email: user?.email,
            },
            "IdP login denied due to strict mode",
          );
          throw new APIError("FORBIDDEN", {
            message: result.error,
          });
        }

        logger.info(
          {
            providerId: provider.providerId,
            assignedRole: result.role,
            matched: result.matched,
          },
          "IdP role mapping evaluated",
        );

        // Cache IdP groups for team sync (if user email is available)
        if (user?.email && idpProvider.organizationId) {
          const groups = extractGroupsFromClaims(
            tokenClaims,
            idpProvider.teamSyncConfig,
          );
          if (groups.length > 0) {
            await cacheIdpGroups(
              provider.providerId,
              user.email,
              idpProvider.organizationId,
              groups,
            );
          }
        }

        return result.role as string;
      }

      // If no role mapping is configured but we still have groups, cache them for team sync
      if (idpProvider?.organizationId && user?.email) {
        const tokenClaimsForCache =
          idTokenClaims || (token as Record<string, unknown>) || {};
        const groups = extractGroupsFromClaims(
          tokenClaimsForCache,
          idpProvider.teamSyncConfig,
        );
        if (groups.length > 0) {
          await cacheIdpGroups(
            provider.providerId,
            user.email,
            idpProvider.organizationId,
            groups,
          );
          logger.debug(
            {
              providerId: provider.providerId,
              email: user.email,
              groupCount: groups.length,
            },
            "Cached IdP groups for team sync (no role mapping configured)",
          );
        }
      }
    } catch (error) {
      // Re-throw APIError (for strict mode)
      if (error instanceof APIError) {
        logger.debug(
          {
            providerId: provider?.providerId,
            errorMessage: error.message,
          },
          "resolveSsoRole: Re-throwing APIError (strict mode denial)",
        );
        throw error;
      }
      logger.error(
        { err: error, providerId: provider?.providerId },
        "resolveSsoRole: Error evaluating IdP role mapping",
      );
    }

    // Fallback to default role when no role mapping is configured
    logger.debug(
      {
        providerId: provider?.providerId,
        fallbackRole: MEMBER_ROLE_NAME,
      },
      "resolveSsoRole: Using fallback role (no role mapping configured or error occurred)",
    );
    return MEMBER_ROLE_NAME;
  }

  /**
   * Find all identity providers with minimal public info only.
   * Use this for public/unauthenticated endpoints (e.g., login page SSO buttons).
   * Does NOT expose any sensitive configuration data.
   */
  static async findAllPublic(): Promise<PublicIdentityProvider[]> {
    const idpProviders = await db
      .select({
        id: schema.identityProvidersTable.id,
        providerId: schema.identityProvidersTable.providerId,
      })
      .from(schema.identityProvidersTable);

    return idpProviders;
  }

  /**
   * Find all identity providers with full configuration including secrets.
   * Use this only for authenticated admin endpoints.
   * Filters by organizationId to enforce multi-tenant isolation.
   */
  static async findAll(organizationId: string): Promise<IdentityProvider[]> {
    const idpProviders = await db
      .select()
      .from(schema.identityProvidersTable)
      .where(eq(schema.identityProvidersTable.organizationId, organizationId));

    return idpProviders.map((provider) => ({
      ...provider,
      oidcConfig: provider.oidcConfig
        ? JSON.parse(provider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: provider.samlConfig
        ? JSON.parse(provider.samlConfig as unknown as string)
        : undefined,
      roleMapping: provider.roleMapping
        ? JSON.parse(provider.roleMapping as unknown as string)
        : undefined,
      teamSyncConfig: provider.teamSyncConfig
        ? JSON.parse(provider.teamSyncConfig as unknown as string)
        : undefined,
    }));
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<IdentityProvider | null> {
    const [idpProvider] = await db
      .select()
      .from(schema.identityProvidersTable)
      .where(
        and(
          eq(schema.identityProvidersTable.id, id),
          eq(schema.identityProvidersTable.organizationId, organizationId),
        ),
      );

    if (!idpProvider) {
      return null;
    }

    return {
      ...idpProvider,
      oidcConfig: idpProvider.oidcConfig
        ? JSON.parse(idpProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: idpProvider.samlConfig
        ? JSON.parse(idpProvider.samlConfig as unknown as string)
        : undefined,
      roleMapping: idpProvider.roleMapping
        ? JSON.parse(idpProvider.roleMapping as unknown as string)
        : undefined,
      teamSyncConfig: idpProvider.teamSyncConfig
        ? JSON.parse(idpProvider.teamSyncConfig as unknown as string)
        : undefined,
    };
  }

  /**
   * Find identity provider by providerId (the user-facing unique identifier).
   * Used by role mapping during SSO authentication.
   */
  static async findByProviderId(
    providerId: string,
  ): Promise<IdentityProvider | null> {
    const [idpProvider] = await db
      .select()
      .from(schema.identityProvidersTable)
      .where(eq(schema.identityProvidersTable.providerId, providerId));

    if (!idpProvider) {
      return null;
    }

    return {
      ...idpProvider,
      oidcConfig: idpProvider.oidcConfig
        ? JSON.parse(idpProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: idpProvider.samlConfig
        ? JSON.parse(idpProvider.samlConfig as unknown as string)
        : undefined,
      roleMapping: idpProvider.roleMapping
        ? JSON.parse(idpProvider.roleMapping as unknown as string)
        : undefined,
      teamSyncConfig: idpProvider.teamSyncConfig
        ? JSON.parse(idpProvider.teamSyncConfig as unknown as string)
        : undefined,
    };
  }

  static async create(
    data: Omit<InsertIdentityProvider, "id">,
    organizationId: string,
    headers: HeadersInit,
    auth: BetterAuth,
  ): Promise<IdentityProvider> {
    // Parse JSON configs if they exist
    const parsedData = {
      providerId: data.providerId,
      issuer: data.issuer,
      domain: data.domain,
      organizationId,
      ...(data.oidcConfig && {
        oidcConfig:
          typeof data.oidcConfig === "string"
            ? JSON.parse(data.oidcConfig)
            : data.oidcConfig,
      }),
      ...(data.samlConfig && {
        samlConfig:
          typeof data.samlConfig === "string"
            ? JSON.parse(data.samlConfig)
            : data.samlConfig,
      }),
    };

    // Ensure required mapping fields for OIDC
    if (parsedData.oidcConfig?.mapping) {
      parsedData.oidcConfig.mapping = {
        id: parsedData.oidcConfig.mapping.id || "sub",
        email: parsedData.oidcConfig.mapping.email || "email",
        name: parsedData.oidcConfig.mapping.name || "name",
        ...parsedData.oidcConfig.mapping,
      };
    }

    // Register with Better Auth
    await auth.api.registerSSOProvider({
      body: parsedData,
      headers: new Headers(headers),
    });

    // Better Auth automatically creates the database record, so we need to find it
    // The provider ID should be unique, so we can find by providerId and organizationId
    const createdProvider = await db
      .select()
      .from(schema.identityProvidersTable)
      .where(
        and(
          eq(schema.identityProvidersTable.providerId, data.providerId),
          eq(schema.identityProvidersTable.organizationId, organizationId),
        ),
      );

    const [provider] = createdProvider;
    if (!provider) {
      throw new Error("Failed to create identity provider");
    }

    /**
     * WORKAROUND: With `domainVerification: { enabled: true }` in Better Auth's SSO plugin,
     * all identity providers require `domainVerified: true` for sign-in to work without DNS verification.
     * We auto-set this for all providers to bypass the DNS verification requirement.
     * See: https://github.com/better-auth/better-auth/issues/6481
     * TODO: Remove this workaround once the upstream issue is fixed.
     */
    // Also store roleMapping and teamSyncConfig if provided (Better Auth doesn't handle these fields)
    // Note: These are stored as JSON text but typed as objects in Drizzle schema
    const roleMappingJson = data.roleMapping
      ? typeof data.roleMapping === "string"
        ? data.roleMapping
        : JSON.stringify(data.roleMapping)
      : undefined;
    const teamSyncConfigJson = data.teamSyncConfig
      ? typeof data.teamSyncConfig === "string"
        ? data.teamSyncConfig
        : JSON.stringify(data.teamSyncConfig)
      : undefined;
    await db
      .update(schema.identityProvidersTable)
      .set({
        domainVerified: true,
        ...(roleMappingJson && {
          roleMapping: roleMappingJson as unknown as typeof data.roleMapping,
        }),
        ...(teamSyncConfigJson && {
          teamSyncConfig:
            teamSyncConfigJson as unknown as typeof data.teamSyncConfig,
        }),
      })
      .where(eq(schema.identityProvidersTable.id, provider.id));

    return {
      ...provider,
      domainVerified: true,
      oidcConfig: provider.oidcConfig
        ? JSON.parse(provider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: provider.samlConfig
        ? JSON.parse(provider.samlConfig as unknown as string)
        : undefined,
      roleMapping: data.roleMapping
        ? typeof data.roleMapping === "string"
          ? JSON.parse(data.roleMapping)
          : data.roleMapping
        : undefined,
      teamSyncConfig: data.teamSyncConfig
        ? typeof data.teamSyncConfig === "string"
          ? JSON.parse(data.teamSyncConfig)
          : data.teamSyncConfig
        : undefined,
    };
  }

  static async update(
    id: string,
    data: Partial<UpdateIdentityProvider>,
    organizationId: string,
  ): Promise<IdentityProvider | null> {
    // First check if the provider exists
    const existingProvider = await IdentityProviderModel.findById(
      id,
      organizationId,
    );
    if (!existingProvider) {
      return null;
    }

    // Serialize roleMapping and teamSyncConfig if provided as objects
    // Note: These are stored as JSON text but typed as objects in Drizzle schema
    const { roleMapping, teamSyncConfig, ...restData } = data;
    const roleMappingJson =
      roleMapping !== undefined
        ? typeof roleMapping === "string" || roleMapping === null
          ? roleMapping
          : JSON.stringify(roleMapping)
        : undefined;
    const teamSyncConfigJson =
      teamSyncConfig !== undefined
        ? typeof teamSyncConfig === "string" || teamSyncConfig === null
          ? teamSyncConfig
          : JSON.stringify(teamSyncConfig)
        : undefined;

    // Update in database
    // WORKAROUND: Always ensure domainVerified is true to enable account linking
    // See: https://github.com/better-auth/better-auth/issues/6481
    const [updatedProvider] = await db
      .update(schema.identityProvidersTable)
      .set({
        ...restData,
        domainVerified: true,
        ...(roleMappingJson !== undefined && {
          roleMapping: roleMappingJson as unknown as typeof roleMapping,
        }),
        ...(teamSyncConfigJson !== undefined && {
          teamSyncConfig:
            teamSyncConfigJson as unknown as typeof teamSyncConfig,
        }),
      })
      .where(
        and(
          eq(schema.identityProvidersTable.id, id),
          eq(schema.identityProvidersTable.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updatedProvider) return null;

    return {
      ...updatedProvider,
      oidcConfig: updatedProvider.oidcConfig
        ? JSON.parse(updatedProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: updatedProvider.samlConfig
        ? JSON.parse(updatedProvider.samlConfig as unknown as string)
        : undefined,
      roleMapping: updatedProvider.roleMapping
        ? JSON.parse(updatedProvider.roleMapping as unknown as string)
        : undefined,
      teamSyncConfig: updatedProvider.teamSyncConfig
        ? JSON.parse(updatedProvider.teamSyncConfig as unknown as string)
        : undefined,
    };
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    // First check if the provider exists
    const existingProvider = await IdentityProviderModel.findById(
      id,
      organizationId,
    );
    if (!existingProvider) {
      return false;
    }

    // Wrap deletions in a transaction to ensure atomicity
    await db.transaction(async (tx) => {
      /**
       * Clean up associated SSO accounts to prevent orphaned records
       * This is important because orphaned accounts can cause issues with future IdP logins
       * (e.g., the syncSsoRole/syncSsoTeams functions might pick up the wrong account)
       */
      const deletedAccounts = await AccountModel.deleteByProviderId(
        existingProvider.providerId,
        tx,
      );
      if (deletedAccounts > 0) {
        logger.info(
          { providerId: existingProvider.providerId, deletedAccounts },
          "Cleaned up SSO accounts for deleted identity provider",
        );
      }

      // Delete from database
      const deleted = await tx
        .delete(schema.identityProvidersTable)
        .where(
          and(
            eq(schema.identityProvidersTable.id, id),
            eq(schema.identityProvidersTable.organizationId, organizationId),
          ),
        )
        .returning({ id: schema.identityProvidersTable.id });

      if (deleted.length === 0) {
        // Rollback if provider wasn't deleted (though it existed in check above)
        throw new Error("Failed to delete identity provider");
      }
    });

    return true;
  }

  /**
   * Sets domainVerified flag directly (TEST ONLY)
   * This is used to simulate legacy data that has domainVerified: false
   * to test the workaround in update() that sets it back to true.
   * TODO: Remove this when upstream issue is fixed:
   * https://github.com/better-auth/better-auth/issues/6481
   */
  static async setDomainVerifiedForTesting(
    id: string,
    domainVerified: boolean,
  ): Promise<void> {
    logger.debug(
      { id, domainVerified },
      "IdentityProviderModel.setDomainVerifiedForTesting: setting domainVerified",
    );
    await db
      .update(schema.identityProvidersTable)
      .set({ domainVerified })
      .where(eq(schema.identityProvidersTable.id, id));
    logger.debug(
      { id, domainVerified },
      "IdentityProviderModel.setDomainVerifiedForTesting: completed",
    );
  }
}

export default IdentityProviderModel;
