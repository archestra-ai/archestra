import { jwtVerify, SignJWT } from "jose";
import config from "@/config";

/**
 * Internal JWT for backend-to-backend authentication
 * Used for MCP proxy requests and other internal service calls
 */

const ISSUER = "archestra-backend";
const AUDIENCE = "archestra-internal";

/**
 * Pre-generated long-lived internal JWT token
 * Generated once at server startup with 1 year expiration
 */
let internalToken: string | null = null;

/**
 * Initialize the internal JWT token at server startup
 * Call this once when the server starts
 */
export const initializeInternalJwt = async (): Promise<void> => {
  const secret = new TextEncoder().encode(config.auth.secret ?? "");

  internalToken = await new SignJWT({ service: "archestra-backend" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime("99y")
    .sign(secret);
};

/**
 * Get the pre-generated internal JWT token
 * @returns The internal JWT token
 * @throws Error if token hasn't been initialized
 */
export const getInternalJwt = (): string => {
  if (!internalToken) {
    throw new Error(
      "Internal JWT not initialized. Call initializeInternalJwt() at server startup.",
    );
  }
  return internalToken;
};

/**
 * Verify an internal JWT token
 * @param token The JWT token to verify
 * @returns The verified payload or null if invalid
 */
export const verifyInternalJwt = async (
  token: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const secret = new TextEncoder().encode(config.auth.secret ?? "");

    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    return payload as Record<string, unknown>;
  } catch (_error) {
    // Token is invalid, expired, or malformed
    return null;
  }
};
