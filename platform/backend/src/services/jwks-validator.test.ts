import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "@/test";
import { jwksValidator } from "./jwks-validator";

// We'll generate a real RSA key pair for testing
let privateKey: CryptoKey;

/**
 * A real JWKS endpoint on a loopback port. Serving the public key over HTTP —
 * rather than stubbing jose — keeps signature verification and claim
 * extraction on their real code path, so these tests fail if either breaks.
 */
let jwksServer: Server;
let jwksUrl: string;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  privateKey = keyPair.privateKey as CryptoKey;

  const publicJwk = await exportJWK(keyPair.publicKey as CryptoKey);
  const body = JSON.stringify({
    keys: [{ ...publicJwk, kid: "test-kid-1", alg: "RS256", use: "sig" }],
  });

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) =>
    jwksServer.listen(0, "127.0.0.1", resolve),
  );
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

afterEach(() => {
  jwksValidator.clearCache();
});

/**
 * Helper to create a signed JWT
 */
async function createSignedJwt(params: {
  sub?: string;
  email?: string;
  name?: string;
  iss?: string;
  aud?: string;
  exp?: number;
  extraClaims?: Record<string, unknown>;
}): Promise<string> {
  const builder = new SignJWT({
    ...(params.email && { email: params.email }),
    ...(params.name && { name: params.name }),
    ...params.extraClaims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
    .setIssuedAt();

  if (params.sub) builder.setSubject(params.sub);
  if (params.iss) builder.setIssuer(params.iss);
  if (params.aud) builder.setAudience(params.aud);
  if (params.exp) {
    builder.setExpirationTime(params.exp);
  } else {
    builder.setExpirationTime("1h");
  }

  return builder.sign(privateKey);
}

describe("JwksValidator", () => {
  // These reject before any key is fetched, so the JWKS URL is never reached.
  describe("validateJwt rejects malformed and expired tokens", () => {
    test("returns null for malformed tokens", async () => {
      const result = await jwksValidator.validateJwt({
        token: "not-a-jwt",
        issuerUrl: "https://idp.example.com",
        jwksUrl: "https://idp.example.com/.well-known/jwks.json",
        audience: null,
      });

      expect(result).toBeNull();
    });

    test("returns null for expired tokens (even with valid signature)", async () => {
      // Create a token that expired 2 minutes ago (beyond the 30s clock tolerance)
      const token = await createSignedJwt({
        sub: "user-1",
        email: "test@example.com",
        iss: "https://idp.example.com",
        exp: Math.floor(Date.now() / 1000) - 120,
      });

      const result = await jwksValidator.validateJwt({
        token,
        issuerUrl: "https://idp.example.com",
        jwksUrl: "https://idp.example.com/.well-known/jwks.json",
        audience: null,
      });

      expect(result).toBeNull();
    });

    test("returns null for empty token string", async () => {
      const result = await jwksValidator.validateJwt({
        token: "",
        issuerUrl: "https://idp.example.com",
        jwksUrl: "https://idp.example.com/.well-known/jwks.json",
        audience: null,
      });

      expect(result).toBeNull();
    });
  });

  describe("claim extraction", () => {
    const ISSUER = "https://idp.example.com";
    const NAMESPACED_CLAIM = "https://example.com/email";

    async function validate(params: {
      token: string;
      emailClaim?: string | null;
    }) {
      return jwksValidator.validateJwt({
        token: params.token,
        issuerUrl: ISSUER,
        jwksUrl,
        audience: null,
        ...(params.emailClaim !== undefined && {
          emailClaim: params.emailClaim,
        }),
      });
    }

    test("preferred_username is used when name is missing", async () => {
      const token = await createSignedJwt({
        sub: "user-1",
        iss: ISSUER,
        extraClaims: { preferred_username: "alice" },
      });

      const result = await validate({ token });

      expect(result?.name).toBe("alice");
    });

    test("reads the email from the IdP's configured claim when the standard claim is absent", async () => {
      // The case that made namespaced-claim IdPs unusable: the token carries
      // the email, just not under `email`.
      const token = await createSignedJwt({
        sub: "auth-provider|user-1",
        iss: ISSUER,
        extraClaims: { [NAMESPACED_CLAIM]: "user@example.com" },
      });

      const result = await validate({ token, emailClaim: NAMESPACED_CLAIM });

      expect(result?.email).toBe("user@example.com");
    });

    test("the configured claim wins over a standard email claim", async () => {
      const token = await createSignedJwt({
        sub: "user-1",
        iss: ISSUER,
        email: "standard@example.com",
        extraClaims: { [NAMESPACED_CLAIM]: "mapped@example.com" },
      });

      const result = await validate({ token, emailClaim: NAMESPACED_CLAIM });

      expect(result?.email).toBe("mapped@example.com");
    });

    test("falls back to the standard email claim when no mapping is configured", async () => {
      const token = await createSignedJwt({
        sub: "user-1",
        iss: ISSUER,
        email: "standard@example.com",
      });

      const result = await validate({ token });

      expect(result?.email).toBe("standard@example.com");
    });

    test("falls back to the standard email claim when the mapped claim is absent", async () => {
      const token = await createSignedJwt({
        sub: "user-1",
        iss: ISSUER,
        email: "standard@example.com",
      });

      const result = await validate({ token, emailClaim: NAMESPACED_CLAIM });

      expect(result?.email).toBe("standard@example.com");
    });

    test("email is null when neither the mapped nor the standard claim is present", async () => {
      const token = await createSignedJwt({ sub: "user-1", iss: ISSUER });

      const result = await validate({ token, emailClaim: NAMESPACED_CLAIM });

      expect(result?.sub).toBe("user-1");
      expect(result?.email).toBeNull();
    });
  });

  describe("cache management", () => {
    test("clearCache removes all cached JWKS instances", () => {
      // Access private cache through the public clearCache method
      // Just verify it doesn't throw
      jwksValidator.clearCache();
    });
  });
});
