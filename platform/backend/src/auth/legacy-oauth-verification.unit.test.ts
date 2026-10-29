import { verifyAccessToken } from "better-auth/oauth2";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { useMswServer } from "@/test/msw";

const ISSUER = "https://oauth-compat.example.test";
const AUDIENCE = "https://resource.example.test";
const JWKS = `${ISSUER}/jwks`;
const INTROSPECT = `${ISSUER}/introspect`;
describe("legacy OAuth bearer verification", () => {
  const server = useMswServer();
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let publicKey: Awaited<ReturnType<typeof exportJWK>>;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicKey = await exportJWK(pair.publicKey);
  });

  beforeEach(() => {
    server.use(
      http.get(JWKS, () =>
        HttpResponse.json({
          keys: [{ ...publicKey, kid: "compat-key", alg: "RS256" }],
        }),
      ),
    );
  });

  const options = {
    jwksUrl: JWKS,
    verifyOptions: {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["RS256"],
    },
    scopes: ["read"],
  };

  async function token(claims: Record<string, unknown> = {}, expires = "1h") {
    return new SignJWT({
      sub: "test-user",
      iss: ISSUER,
      aud: AUDIENCE,
      scope: "read write",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "compat-key" })
      .setIssuedAt()
      .setExpirationTime(expires)
      .sign(privateKey);
  }

  test("the legacy export verifies a signed bearer token with its required scope", async () => {
    await expect(
      verifyAccessToken(await token(), options),
    ).resolves.toMatchObject({
      sub: "test-user",
    });
  });

  test.each([
    ["issuer", { iss: "https://other-issuer.example.test" }],
    ["audience", { aud: "https://other-resource.example.test" }],
    ["sender binding", { cnf: { jkt: "a".repeat(43) } }],
  ])("rejects a bearer token with the wrong %s", async (_, claims) => {
    await expect(
      verifyAccessToken(await token(claims), options),
    ).rejects.toMatchObject({
      status: "UNAUTHORIZED",
    });
  });

  test("retains exact required-scope membership", async () => {
    await expect(
      verifyAccessToken(await token({ scope: "read:all write" }), options),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  test("rejects expired tokens", async () => {
    await expect(
      verifyAccessToken(await token({}, "-1h"), options),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  test.each([
    true,
    false,
  ])("introspection preserves audience checks (aud present: %s)", async (withAudience) => {
    server.use(
      http.post(INTROSPECT, () =>
        HttpResponse.json({
          active: true,
          iss: ISSUER,
          ...(withAudience ? { aud: AUDIENCE } : {}),
          scope: "read",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );
    const result = verifyAccessToken("opaque-access-token", {
      ...options,
      remoteVerify: {
        introspectUrl: INTROSPECT,
        clientId: "test-client",
        clientSecret: "test-client-secret",
        force: true,
      },
    });
    if (withAudience)
      await expect(result).resolves.toMatchObject({ aud: AUDIENCE });
    else await expect(result).rejects.toThrow('missing required "aud" claim');
  });
});
