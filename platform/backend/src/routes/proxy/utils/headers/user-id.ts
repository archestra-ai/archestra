import { USER_ID_HEADER } from "@shared";
import logger from "@/logging";
import { UserModel } from "@/models";

const OPENWEBUI_EMAIL_HEADER = "x-openwebui-user-email";

export type UserSource = "archestra-header" | "openwebui-email";

export interface UserResult {
  userId: string;
  source: UserSource;
}

/**
 * Resolve user identity from request headers.
 *
 * Resolution order:
 * 1. `X-Archestra-User-Id` header — direct user ID lookup
 * 2. `x-openwebui-user-email` header — email-based lookup (Open WebUI forwarded headers)
 *
 * @returns The resolved user ID and source, or undefined if no user could be resolved
 */
export async function getUser(
  headers: Record<string, string | string[] | undefined>,
): Promise<UserResult | undefined> {
  // 1. Try X-Archestra-User-Id header first
  const archestraUserId = extractHeaderValue(
    headers,
    USER_ID_HEADER.toLowerCase(),
  );

  if (archestraUserId) {
    try {
      const user = await UserModel.getById(archestraUserId);
      if (user) {
        return { userId: archestraUserId, source: "archestra-header" };
      }
      logger.warn(
        { userId: archestraUserId },
        "Invalid X-Archestra-User-Id header: user not found, trying fallback headers",
      );
    } catch (error) {
      logger.warn(
        { userId: archestraUserId, error },
        "Error validating X-Archestra-User-Id header, trying fallback headers",
      );
    }
  }

  // 2. Fallback: try x-openwebui-user-email header
  const email = extractHeaderValue(headers, OPENWEBUI_EMAIL_HEADER);

  if (email) {
    try {
      const user = await UserModel.findByEmail(email);
      if (user) {
        logger.info(
          { email, userId: user.id },
          "Resolved user from x-openwebui-user-email header",
        );
        return { userId: user.id, source: "openwebui-email" };
      }
      logger.warn(
        { email },
        "x-openwebui-user-email header: no matching Archestra user found",
      );
    } catch (error) {
      logger.warn(
        { email, error },
        "Error looking up user by x-openwebui-user-email header",
      );
    }
  }

  return undefined;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function extractHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = headers[key];

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "string" && first.trim().length > 0) {
      return first.trim();
    }
  }

  return undefined;
}
