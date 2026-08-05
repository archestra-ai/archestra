// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Contract under test — browser-key MCP credential crypto:
 * - a credential value roundtrips under the browser key
 * - the AAD binds an envelope to its mcp_server id (no transplant)
 * - the fingerprint binds the key to one server id
 * - the escrow blob is independently recoverable with the RSA private key
 * - the boot guard/enablement matrix (EE license × escrow key)
 * - unlockCredentialBag is terminal: locked without a key, mismatch on a
 *   wrong key, transient plaintext with the right one
 */
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import {
  BrowserCredentialKeyMismatchError,
  BrowserLockedCredentialError,
  credentialKeyFingerprint,
  credentialKeyMatches,
  decryptCredentialValue,
  encryptCredentialBagValues,
  encryptCredentialValue,
  isCredentialEnvelope,
  isMcpBrowserCredentialsEnabled,
  unlockCredentialBag,
  verifyMcpBrowserCredentialConfig,
  wrapCredentialKey,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "./browser-credential.ee";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const SERVER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("browser-key MCP credential crypto", () => {
  let key: Buffer;

  beforeEach(() => {
    config.enterpriseFeatures.core = true;
    config.mcpBrowserCredentials.escrowPublicKey = ESCROW_PEM;
    key = randomBytes(32);
  });

  test("a credential value roundtrips under the browser key", () => {
    const envelope = encryptCredentialValue("sk-super-secret", {
      key,
      mcpServerId: SERVER_A,
    });
    expect(isCredentialEnvelope(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain("sk-super-secret");
    expect(
      decryptCredentialValue(envelope, { key, mcpServerId: SERVER_A }),
    ).toBe("sk-super-secret");
  });

  test("the AAD rejects an envelope transplanted to another server id", () => {
    const envelope = encryptCredentialValue("sk-super-secret", {
      key,
      mcpServerId: SERVER_A,
    });
    expect(() =>
      decryptCredentialValue(envelope, { key, mcpServerId: SERVER_B }),
    ).toThrow();
  });

  test("plain strings pass through decryption (mixed bags)", () => {
    expect(
      decryptCredentialValue("not-an-envelope", {
        key,
        mcpServerId: SERVER_A,
      }),
    ).toBe("not-an-envelope");
  });

  test("the fingerprint binds the key to one server id", () => {
    const fingerprint = credentialKeyFingerprint(SERVER_A, key);
    expect(
      credentialKeyMatches({
        storedFingerprint: fingerprint,
        mcpServerId: SERVER_A,
        key,
      }),
    ).toBe(true);
    // Same key, different server → no match (domain separation).
    expect(
      credentialKeyMatches({
        storedFingerprint: fingerprint,
        mcpServerId: SERVER_B,
        key,
      }),
    ).toBe(false);
    // Different key, same server → no match.
    expect(
      credentialKeyMatches({
        storedFingerprint: fingerprint,
        mcpServerId: SERVER_A,
        key: randomBytes(32),
      }),
    ).toBe(false);
    // The fingerprint is a digest, not the key.
    expect(fingerprint).not.toContain(key.toString("base64url"));
  });

  test("the escrow blob is recoverable with the RSA private key", () => {
    const escrow = wrapCredentialKey(key);
    expect(escrow.alg).toBe("RSA-OAEP-256");
    const recovered = privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(escrow.wrappedDek, "base64"),
    );
    expect(recovered.equals(key)).toBe(true);
  });

  describe("boot guard / enablement matrix", () => {
    test("enabled only with EE license AND a valid escrow key", () => {
      expect(isMcpBrowserCredentialsEnabled()).toBe(true);

      config.enterpriseFeatures.core = false;
      expect(isMcpBrowserCredentialsEnabled()).toBe(false);

      config.enterpriseFeatures.core = true;
      config.mcpBrowserCredentials.escrowPublicKey = undefined;
      expect(isMcpBrowserCredentialsEnabled()).toBe(false);
    });

    test("unset escrow key: boot guard is a no-op", () => {
      config.mcpBrowserCredentials.escrowPublicKey = undefined;
      expect(() => verifyMcpBrowserCredentialConfig()).not.toThrow();
    });

    test("escrow key without an EE license fails startup", () => {
      config.enterpriseFeatures.core = false;
      expect(() => verifyMcpBrowserCredentialConfig()).toThrow(/enterprise/);
    });

    test("an invalid escrow key fails startup (never runs ignored)", () => {
      config.mcpBrowserCredentials.escrowPublicKey = "not-a-pem";
      expect(() => verifyMcpBrowserCredentialConfig()).toThrow();
    });

    test("a valid configuration passes the boot guard", () => {
      expect(() => verifyMcpBrowserCredentialConfig()).not.toThrow();
    });
  });

  describe("unlockCredentialBag", () => {
    const server = () => ({
      id: SERVER_A,
      name: "linear",
      browserKeyFingerprint: credentialKeyFingerprint(SERVER_A, key),
    });

    test("no key → browser-locked (terminal, typed)", () => {
      expect(() =>
        unlockCredentialBag({ server: server(), secrets: {}, key: null }),
      ).toThrow(BrowserLockedCredentialError);
    });

    test("wrong key → mismatch (typed)", () => {
      expect(() =>
        unlockCredentialBag({
          server: server(),
          secrets: {},
          key: randomBytes(32),
        }),
      ).toThrow(BrowserCredentialKeyMismatchError);
    });

    test("valid key → transient plaintext bag; static values pass through", () => {
      const sealed = encryptCredentialBagValues(
        { access_token: "sk-tok", tenant_id: "acme" },
        { key, mcpServerId: SERVER_A, skipKeys: new Set(["tenant_id"]) },
      );
      expect(isCredentialEnvelope(sealed.access_token)).toBe(true);
      expect(sealed.tenant_id).toBe("acme");

      const unlocked = unlockCredentialBag({
        server: server(),
        secrets: sealed,
        key,
      });
      expect(unlocked).toEqual({ access_token: "sk-tok", tenant_id: "acme" });
    });
  });
});
