import type { SsoRoleMappingConfig } from "@shared";
import { MEMBER_ROLE_NAME } from "@shared";
import jmespath from "jmespath";
import logger from "@/logging";

interface RoleMappingContext {
  userInfo: Record<string, unknown>;
  token?: Record<string, unknown>;
  provider: {
    id: string;
    providerId: string;
  };
}

export interface RoleMappingResult {
  /** The resolved role (or null if strict mode and no match) */
  role: string | null;
  /** Whether a rule explicitly matched */
  matched: boolean;
  /** Error message if login should be denied (strict mode) */
  error?: string;
}

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
export function evaluateRoleMapping(
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
    case "combined":
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
