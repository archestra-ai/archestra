import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import logger from "@/logging";

/**
 * Result of a successful JWT validation via JWKS
 */
export interface JwksValidationResult {
  sub: string;
  email: string | null;
  name: string | null;
  rawClaims: Record<string, unknown>;
}

/**
 * Validates JWTs using JWKS (JSON Web Key Sets) from external Identity Providers.
 *
 * Uses jose's createRemoteJWKSet which handles:
 * - Fetching and caching public keys from the JWKS endpoint
 * - Automatic key rotation (re-fetches keys when unknown kid is encountered)
 * - Key selection by kid (Key ID) header
 */
class JwksValidator {
  private static readonly MAX_CACHE_SIZE = 100;
  private jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  /**
   * Validate a JWT against an external IdP's JWKS endpoint.
   *
   * @returns Validated identity claims, or null if validation fails
   */
  async validateJwt(params: {
    token: string;
    issuerUrl: string;
    jwksUrl: string;
    audience: string | null;
  }): Promise<JwksValidationResult | null> {
    const { token, issuerUrl, jwksUrl, audience } = params;

    try {
      const jwks = this.getOrCreateJwks(jwksUrl);

      const { payload } = await jwtVerify(token, jwks as JWTVerifyGetKey, {
        issuer: issuerUrl,
        ...(audience && { audience }),
        clockTolerance: 30,
      });

      const sub = payload.sub;
      if (!sub) {
        logger.warn({ issuerUrl }, "JWKS validation: JWT missing 'sub' claim");
        return null;
      }

      return {
        sub,
        email: extractStringClaim(payload, "email"),
        name:
          extractStringClaim(payload, "name") ??
          extractStringClaim(payload, "preferred_username"),
        rawClaims: payload as Record<string, unknown>,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Expected validation failures (expired, bad signature) log at debug;
      // unexpected errors (network, malformed key) log at warn.
      const isExpected =
        message.includes("expired") ||
        message.includes("signature") ||
        message.includes("JWS") ||
        message.includes("JWT");
      const level = isExpected ? "debug" : "warn";
      logger[level](
        { issuerUrl, error: message },
        "JWKS JWT validation failed",
      );
      return null;
    }
  }

  /**
   * Clear the JWKS cache (useful for testing)
   */
  clearCache(): void {
    this.jwksCache.clear();
  }

  private getOrCreateJwks(
    jwksUrl: string,
  ): ReturnType<typeof createRemoteJWKSet> {
    let jwks = this.jwksCache.get(jwksUrl);
    if (!jwks) {
      // Evict oldest entry if cache is full
      if (this.jwksCache.size >= JwksValidator.MAX_CACHE_SIZE) {
        const oldestKey = this.jwksCache.keys().next().value;
        if (oldestKey) this.jwksCache.delete(oldestKey);
      }
      jwks = createRemoteJWKSet(new URL(jwksUrl));
      this.jwksCache.set(jwksUrl, jwks);
    }
    return jwks;
  }
}

function extractStringClaim(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

export const jwksValidator = new JwksValidator();
