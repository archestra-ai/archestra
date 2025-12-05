import type { SSOOptions } from "@better-auth/sso";
import type { SsoRoleMappingConfig } from "@shared";
import { MEMBER_ROLE_NAME } from "@shared";
import { APIError } from "better-auth";
import { and, eq } from "drizzle-orm";
import jmespath from "jmespath";
import { jwtDecode } from "jwt-decode";
import { auth } from "@/auth/better-auth";
import {
  cacheSsoGroups,
  extractGroupsFromClaims,
} from "@/auth/sso-team-sync-cache";
import db, { schema } from "@/database";
import logger from "@/logging";

import type {
  InsertSsoProvider,
  PublicSsoProvider,
  SsoProvider,
  UpdateSsoProvider,
} from "@/types";
import MemberModel from "./member";

interface RoleMappingContext {
  userInfo: Record<string, unknown>;
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

export type SsoGetRoleData = Parameters<
  NonNullable<NonNullable<SSOOptions["organizationProvisioning"]>["getRole"]>
>[0];

class SsoProviderModel {
  /**
   * Evaluates role mapping rules against SSO user data using JMESPath expressions.
   *
   * @example
   * // Map users with "admin" in their groups array to admin role
   * { expression: "contains(groups || `[]`, 'admin')", role: "admin" }
   *
   * @example
   * // Map users with specific department
   * { expression: "department == 'Engineering'", role: "member" }
   *
   * @example
   * // Map users with role claim
   * { expression: "roles[?@ == 'archestra-admin'] | [0]", role: "admin" }
   */
  static evaluateRoleMapping(
    config: SsoRoleMappingConfig | undefined,
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

    // Build the data object based on dataSource configuration
    let data: Record<string, unknown>;
    switch (config.dataSource) {
      case "userInfo":
        data = context.userInfo;
        break;
      case "token":
        data = context.token || {};
        break;
      default:
        // Merge token and userInfo, with userInfo taking precedence
        data = { ...context.token, ...context.userInfo };
        break;
    }

    logger.debug(
      { providerId: context.provider.providerId, dataKeys: Object.keys(data) },
      "Evaluating role mapping rules",
    );

    // Evaluate rules in order, first match wins
    for (const rule of config.rules) {
      try {
        const result = jmespath.search(data, rule.expression);

        // JMESPath returns null for no match, so we check for truthy values
        // This handles: true, non-empty strings, non-empty arrays, non-null objects
        const matches =
          Boolean(result) &&
          (typeof result !== "object" ||
            (Array.isArray(result)
              ? result.length > 0
              : Object.keys(result as Record<string, unknown>).length > 0));

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
          "Access denied: Your account does not match any role mapping rules configured for this SSO provider.",
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
   * Dynamic role assignment based on SSO provider role mapping configuration.
   * Uses JMESPath expressions to evaluate user attributes from the IdP.
   *
   * Supports:
   * - JMESPath-based role mapping rules
   * - Strict mode: Deny login if no rules match
   * - Skip role sync: Only set role on first login
   *
   * @param data - SSO user data from the identity provider
   * @returns The resolved role ("member" | "admin" | custom role)
   * @throws APIError with FORBIDDEN if strict mode is enabled and no rules match
   */
  static async resolveSsoRole(data: SsoGetRoleData): Promise<string> {
    const { user, token, provider, userInfo } = data;

    // Better-auth passes the raw OAuth token response, not decoded JWT claims.
    // We need to decode the idToken to get claims like 'groups' for role mapping.
    const idTokenJwt = token?.idToken;
    let idTokenClaims: Record<string, unknown> | null = null;
    if (idTokenJwt) {
      try {
        idTokenClaims = jwtDecode<Record<string, unknown>>(idTokenJwt);
      } catch {
        logger.warn("Failed to decode idToken JWT for role mapping");
      }
    }

    try {
      // Fetch the SSO provider configuration to get role mapping rules
      const ssoProvider = await SsoProviderModel.findByProviderId(
        provider.providerId,
      );

      if (ssoProvider?.roleMapping) {
        const roleMapping = ssoProvider.roleMapping;

        // Handle skipRoleSync: If enabled and user already has a membership in this organization, keep their current role
        if (roleMapping.skipRoleSync && user?.id) {
          const existingMember = ssoProvider.organizationId
            ? await MemberModel.getByUserId(user.id, ssoProvider.organizationId)
            : null;
          if (existingMember) {
            logger.info(
              {
                providerId: provider.providerId,
                userId: user.id,
                organizationId: ssoProvider.organizationId,
                currentRole: existingMember.role,
              },
              "Skip role sync enabled - keeping existing role",
            );

            // Cache SSO groups for team sync before returning (even when skipping role sync)
            if (user.email && ssoProvider.organizationId) {
              const tokenClaims =
                idTokenClaims || (token as Record<string, unknown>) || {};
              const combinedClaims = {
                ...tokenClaims,
                ...((userInfo as Record<string, unknown>) || {}),
              };
              const groups = extractGroupsFromClaims(combinedClaims);
              if (groups.length > 0) {
                cacheSsoGroups(
                  provider.providerId,
                  user.email,
                  ssoProvider.organizationId,
                  groups,
                );
                logger.debug(
                  {
                    providerId: provider.providerId,
                    email: user.email,
                    groupCount: groups.length,
                  },
                  "Cached SSO groups for team sync (skipRoleSync path)",
                );
              }
            }

            return existingMember.role;
          }
        }

        // Evaluate role mapping rules
        // Use decoded idToken claims for 'token' data source (contains groups, roles, etc.)
        // Fall back to raw token claims if idToken couldn't be decoded (e.g., in tests or non-JWT tokens)
        const tokenClaims =
          idTokenClaims || (token as Record<string, unknown>) || {};
        const result = SsoProviderModel.evaluateRoleMapping(
          roleMapping,
          {
            userInfo: (userInfo as Record<string, unknown>) || {},
            token: tokenClaims,
            provider: {
              id: provider.providerId,
              providerId: provider.providerId,
            },
          },
          MEMBER_ROLE_NAME,
        );

        // Handle strict mode: Deny login if no rules matched
        if (result.error) {
          logger.warn(
            {
              providerId: provider.providerId,
              email: user?.email,
            },
            "SSO login denied due to strict mode",
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
          "SSO role mapping evaluated",
        );

        // Cache SSO groups for team sync (if user email is available)
        if (user?.email && ssoProvider.organizationId) {
          const combinedClaims = {
            ...tokenClaims,
            ...((userInfo as Record<string, unknown>) || {}),
          };
          const groups = extractGroupsFromClaims(combinedClaims);
          if (groups.length > 0) {
            cacheSsoGroups(
              provider.providerId,
              user.email,
              ssoProvider.organizationId,
              groups,
            );
          }
        }

        return result.role as string;
      }

      // If no role mapping is configured but we still have groups, cache them for team sync
      if (ssoProvider?.organizationId && user?.email) {
        const combinedClaims = {
          ...idTokenClaims,
          ...(token as Record<string, unknown>),
          ...((userInfo as Record<string, unknown>) || {}),
        };
        const groups = extractGroupsFromClaims(combinedClaims);
        if (groups.length > 0) {
          cacheSsoGroups(
            provider.providerId,
            user.email,
            ssoProvider.organizationId,
            groups,
          );
          logger.debug(
            {
              providerId: provider.providerId,
              email: user.email,
              groupCount: groups.length,
            },
            "Cached SSO groups for team sync (no role mapping configured)",
          );
        }
      }
    } catch (error) {
      // Re-throw APIError (for strict mode)
      if (error instanceof APIError) {
        throw error;
      }
      logger.error(
        { err: error, providerId: provider?.providerId },
        "Error evaluating SSO role mapping",
      );
    }

    // Fallback to default role when no role mapping is configured
    return MEMBER_ROLE_NAME;
  }

  /**
   * Find all SSO providers with minimal public info only.
   * Use this for public/unauthenticated endpoints (e.g., login page SSO buttons).
   * Does NOT expose any sensitive configuration data.
   */
  static async findAllPublic(): Promise<PublicSsoProvider[]> {
    const ssoProviders = await db
      .select({
        id: schema.ssoProvidersTable.id,
        providerId: schema.ssoProvidersTable.providerId,
      })
      .from(schema.ssoProvidersTable);

    return ssoProviders;
  }

  /**
   * Find all SSO providers with full configuration including secrets.
   * Use this only for authenticated admin endpoints.
   * Filters by organizationId to enforce multi-tenant isolation.
   */
  static async findAll(organizationId: string): Promise<SsoProvider[]> {
    const ssoProviders = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(eq(schema.ssoProvidersTable.organizationId, organizationId));

    return ssoProviders.map((provider) => ({
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
    }));
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<SsoProvider | null> {
    const [ssoProvider] = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(
        and(
          eq(schema.ssoProvidersTable.id, id),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      );

    if (!ssoProvider) {
      return null;
    }

    return {
      ...ssoProvider,
      oidcConfig: ssoProvider.oidcConfig
        ? JSON.parse(ssoProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: ssoProvider.samlConfig
        ? JSON.parse(ssoProvider.samlConfig as unknown as string)
        : undefined,
      roleMapping: ssoProvider.roleMapping
        ? JSON.parse(ssoProvider.roleMapping as unknown as string)
        : undefined,
    };
  }

  /**
   * Find SSO provider by providerId (the user-facing unique identifier).
   * Used by role mapping during SSO authentication.
   */
  static async findByProviderId(
    providerId: string,
  ): Promise<SsoProvider | null> {
    const [ssoProvider] = await db
      .select()
      .from(schema.ssoProvidersTable)
      .where(eq(schema.ssoProvidersTable.providerId, providerId));

    if (!ssoProvider) {
      return null;
    }

    return {
      ...ssoProvider,
      oidcConfig: ssoProvider.oidcConfig
        ? JSON.parse(ssoProvider.oidcConfig as unknown as string)
        : undefined,
      samlConfig: ssoProvider.samlConfig
        ? JSON.parse(ssoProvider.samlConfig as unknown as string)
        : undefined,
      roleMapping: ssoProvider.roleMapping
        ? JSON.parse(ssoProvider.roleMapping as unknown as string)
        : undefined,
    };
  }

  static async create(
    data: Omit<InsertSsoProvider, "id">,
    organizationId: string,
    headers: HeadersInit,
  ): Promise<SsoProvider> {
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
      .from(schema.ssoProvidersTable)
      .where(
        and(
          eq(schema.ssoProvidersTable.providerId, data.providerId),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      );

    const [provider] = createdProvider;
    if (!provider) {
      throw new Error("Failed to create SSO provider");
    }

    /**
     * WORKAROUND: With `domainVerification: { enabled: true }` in Better Auth's SSO plugin,
     * all SSO providers require `domainVerified: true` for sign-in to work without DNS verification.
     * We auto-set this for all providers to bypass the DNS verification requirement.
     * See: https://github.com/better-auth/better-auth/issues/6481
     * TODO: Remove this workaround once the upstream issue is fixed.
     */
    // Also store roleMapping if provided (Better Auth doesn't handle this field)
    // Note: roleMapping is stored as JSON text but typed as object in Drizzle schema
    const roleMappingJson = data.roleMapping
      ? typeof data.roleMapping === "string"
        ? data.roleMapping
        : JSON.stringify(data.roleMapping)
      : undefined;
    await db
      .update(schema.ssoProvidersTable)
      .set({
        domainVerified: true,
        ...(roleMappingJson && {
          roleMapping: roleMappingJson as unknown as typeof data.roleMapping,
        }),
      })
      .where(eq(schema.ssoProvidersTable.id, provider.id));

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
    };
  }

  static async update(
    id: string,
    data: Partial<UpdateSsoProvider>,
    organizationId: string,
  ): Promise<SsoProvider | null> {
    // First check if the provider exists
    const existingProvider = await SsoProviderModel.findById(
      id,
      organizationId,
    );
    if (!existingProvider) {
      return null;
    }

    // Serialize roleMapping if provided as object
    // Note: roleMapping is stored as JSON text but typed as object in Drizzle schema
    const { roleMapping, ...restData } = data;
    const roleMappingJson =
      roleMapping !== undefined
        ? typeof roleMapping === "string" || roleMapping === null
          ? roleMapping
          : JSON.stringify(roleMapping)
        : undefined;

    // Update in database
    // WORKAROUND: Always ensure domainVerified is true to enable account linking
    // See: https://github.com/better-auth/better-auth/issues/6481
    const [updatedProvider] = await db
      .update(schema.ssoProvidersTable)
      .set({
        ...restData,
        domainVerified: true,
        ...(roleMappingJson !== undefined && {
          roleMapping: roleMappingJson as unknown as typeof roleMapping,
        }),
      })
      .where(
        and(
          eq(schema.ssoProvidersTable.id, id),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
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
    };
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    // First check if the provider exists
    const existingProvider = await SsoProviderModel.findById(
      id,
      organizationId,
    );
    if (!existingProvider) {
      return false;
    }

    // Delete from database using returning() to verify deletion
    const deleted = await db
      .delete(schema.ssoProvidersTable)
      .where(
        and(
          eq(schema.ssoProvidersTable.id, id),
          eq(schema.ssoProvidersTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.ssoProvidersTable.id });

    return deleted.length > 0;
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
      "SsoProviderModel.setDomainVerifiedForTesting: setting domainVerified",
    );
    await db
      .update(schema.ssoProvidersTable)
      .set({ domainVerified })
      .where(eq(schema.ssoProvidersTable.id, id));
    logger.debug(
      { id, domainVerified },
      "SsoProviderModel.setDomainVerifiedForTesting: completed",
    );
  }
}

export default SsoProviderModel;
