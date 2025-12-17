import { USER_ID_HEADER } from "@shared";
import logger from "@/logging";
import { UserModel } from "@/models";

/**
 * Extract the user ID from request headers and validate it exists in the database.
 * If the user ID is invalid, logs a warning and returns undefined.
 * This prevents foreign key constraint errors when creating interactions.
 *
 * @param headers - The request headers object
 * @returns The user ID if present and valid, undefined otherwise
 */
export async function getUserId(
  headers: Record<string, string | string[] | undefined>,
): Promise<string | undefined> {
  // HTTP headers are case-insensitive, so we check lowercase
  const headerKey = USER_ID_HEADER.toLowerCase();
  const headerValue = headers[headerKey];

  let userId: string | undefined;

  if (typeof headerValue === "string" && headerValue.trim().length > 0) {
    userId = headerValue.trim();
  } else if (Array.isArray(headerValue) && headerValue.length > 0) {
    // Handle case where header might be an array (though unusual for this header)
    const firstValue = headerValue[0];
    if (typeof firstValue === "string" && firstValue.trim().length > 0) {
      userId = firstValue.trim();
    }
  }

  if (!userId) {
    return undefined;
  }

  try {
    const user = await UserModel.getById(userId);
    if (!user) {
      logger.warn(
        { userId },
        "Invalid X-Archestra-User-Id header: user not found, ignoring user association",
      );
      return undefined;
    }
    return userId;
  } catch (error) {
    logger.warn(
      { userId, error },
      "Error validating X-Archestra-User-Id header, ignoring user association",
    );
    return undefined;
  }
}
