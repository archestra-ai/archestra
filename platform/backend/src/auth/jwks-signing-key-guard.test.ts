import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  createJwk,
  generateExportedKeyPair,
  signJWT,
} from "better-auth/plugins/jwt";
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from "jose";
import { describe, expect, test } from "vitest";
import db, { schema } from "@/database";
import JwksModel from "@/models/jwks";
import { auth, JWT_PLUGIN_OPTIONS } from "./better-auth";
import { verifyJwksSigningKey } from "./jwks-signing-key-guard";

/** A secret that is deliberately not the one this instance boots with. */
const PREVIOUS_SECRET = "the-auth-secret-used-before-rotation";

/**
 * Store a JWKS keypair whose private half is encrypted under `secret`,
 * reproducing a key written before the auth secret changed.
 */
async function storeJwkEncryptedWith(secret: string) {
  const { publicWebKey, privateWebKey, alg } =
    await generateExportedKeyPair(JWT_PLUGIN_OPTIONS);
  const [row] = await db
    .insert(schema.jwksTable)
    .values({
      id: `jwk-${secret.length}-${alg}`,
      publicKey: JSON.stringify(publicWebKey),
      privateKey: JSON.stringify(
        await symmetricEncrypt({
          key: secret,
          data: JSON.stringify(privateWebKey),
        }),
      ),
      createdAt: new Date("2020-01-01T00:00:00Z"),
    })
    .returning();
  return row;
}

/**
 * `auth.$context` is typed against this instance's concrete options while the
 * JWT plugin helpers declare the generic `BetterAuthOptions`; the adapter type
 * is invariant in that parameter, so the two never unify despite being the
 * same value at runtime.
 */
async function jwtPluginContext<T>(): Promise<T> {
  return { context: await auth.$context } as unknown as T;
}

/** Sign a token the way OIDC id_token issuance does. */
async function signWithCurrentJwksKey(): Promise<string> {
  return signJWT(await jwtPluginContext<Parameters<typeof signJWT>[0]>(), {
    options: JWT_PLUGIN_OPTIONS,
    payload: { sub: "user-1" },
  });
}

describe("verifyJwksSigningKey", () => {
  test("replaces a signing key the current auth secret cannot decrypt", async () => {
    const stale = await storeJwkEncryptedWith(PREVIOUS_SECRET);

    // This is the live failure: better-auth cannot sign an id_token, so the
    // OAuth token exchange dies for any client requesting the `openid` scope.
    await expect(signWithCurrentJwksKey()).rejects.toThrow(
      /Failed to decrypt private key/,
    );

    await verifyJwksSigningKey();

    const latest = await JwksModel.getLatest();
    expect(latest?.id).not.toBe(stale.id);
    await expect(signWithCurrentJwksKey()).resolves.toEqual(expect.any(String));
  });

  test("keeps the retired key published so already-issued tokens still verify", async () => {
    const stale = await storeJwkEncryptedWith(PREVIOUS_SECRET);
    const privateKey = await importJWK(
      JSON.parse(
        await symmetricDecrypt({
          key: PREVIOUS_SECRET,
          data: JSON.parse(stale.privateKey),
        }),
      ),
      "RS256",
    );
    const token = await new SignJWT({ sub: "previous-user" })
      .setProtectedHeader({ alg: "RS256", kid: stale.id })
      .setExpirationTime("1h")
      .sign(privateKey);

    await verifyJwksSigningKey();

    const rows = await db.select().from(schema.jwksTable);
    expect(rows.map((row) => row.id)).toContain(stale.id);
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/jwks"),
    );
    expect(response.status).toBe(200);
    const verified = await jwtVerify(
      token,
      createLocalJWKSet(await response.json()),
      { algorithms: ["RS256"] },
    );
    expect(verified.payload.sub).toBe("previous-user");
  });

  test("rejects other algorithms before writing keys without algorithm metadata", async () => {
    await expect(
      createJwk(await jwtPluginContext<Parameters<typeof createJwk>[0]>(), {
        ...JWT_PLUGIN_OPTIONS,
        jwks: { keyPairConfig: { alg: "ES256" } },
      }),
    ).rejects.toThrow("Only RS256 signing keys are supported");
    expect(await JwksModel.getLatest()).toBeNull();
  });

  test("leaves a key the current secret can decrypt alone", async () => {
    const existing = await createJwk(
      await jwtPluginContext<Parameters<typeof createJwk>[0]>(),
      JWT_PLUGIN_OPTIONS,
    );

    await verifyJwksSigningKey();

    expect((await JwksModel.getLatest())?.id).toBe(existing.id);
  });

  test("does nothing when no signing key exists yet", async () => {
    await verifyJwksSigningKey();

    expect(await JwksModel.getLatest()).toBeNull();
  });
});
