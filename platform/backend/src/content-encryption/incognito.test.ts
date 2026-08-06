import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { isContentEnvelope } from "@/utils/crypto";
import {
  decryptIncognitoMessageRow,
  encryptIncognitoMessageContent,
  incognitoDekFingerprint,
  incognitoDekMatches,
  isIncognitoChatEnabled,
  parseIncognitoDekHeader,
} from "./incognito";
import {
  isIncognitoEscrowConfigured,
  produceIncognitoEscrow,
  verifyIncognitoChatConfig,
  wrapIncognitoDek,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed code under test
} from "./incognito-escrow.ee";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const CONVERSATION_A = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_B = "22222222-2222-4222-8222-222222222222";

describe("incognito chat crypto", () => {
  test("enabled by default with NO license and NO escrow key; env flag disables", () => {
    // Free feature: nothing enterprise, nothing escrow.
    config.enterpriseFeatures.core = false;
    config.chatIncognito.escrowPublicKey = undefined;
    expect(isIncognitoChatEnabled()).toBe(true);

    config.chatIncognito.enabled = false;
    expect(isIncognitoChatEnabled()).toBe(false);
  });

  test("DEK header parsing enforces exactly 32 base64url bytes", () => {
    expect(parseIncognitoDekHeader(undefined)).toBeNull();
    expect(parseIncognitoDekHeader("")).toBeNull();

    const dek = randomBytes(32);
    const parsed = parseIncognitoDekHeader(dek.toString("base64url"));
    expect(parsed?.equals(dek)).toBe(true);

    expect(() =>
      parseIncognitoDekHeader(randomBytes(16).toString("base64url")),
    ).toThrow(/32 bytes/);
  });

  test("fingerprints bind to the conversation and compare correctly", () => {
    const dek = randomBytes(32);
    const fp = incognitoDekFingerprint(CONVERSATION_A, dek);

    expect(
      incognitoDekMatches({
        storedFingerprint: fp,
        conversationId: CONVERSATION_A,
        dek,
      }),
    ).toBe(true);
    // Same DEK, different conversation: no match (fingerprints don't leak
    // cross-conversation key reuse).
    expect(
      incognitoDekMatches({
        storedFingerprint: fp,
        conversationId: CONVERSATION_B,
        dek,
      }),
    ).toBe(false);
    expect(
      incognitoDekMatches({
        storedFingerprint: fp,
        conversationId: CONVERSATION_A,
        dek: randomBytes(32),
      }),
    ).toBe(false);
  });

  test("message content roundtrips; AAD rejects cross-conversation transplant", () => {
    const dek = randomBytes(32);
    const content = {
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "secret" }],
    };

    const stored = encryptIncognitoMessageContent(content, {
      dek,
      conversationId: CONVERSATION_A,
    });
    // Same envelope shape as the at-rest layer — the backfill sweep must see
    // it as an envelope (and skip it as foreign-key), never as plaintext.
    expect(isContentEnvelope(stored)).toBe(true);

    const row = { content: stored };
    decryptIncognitoMessageRow(row, { dek, conversationId: CONVERSATION_A });
    expect(row.content).toEqual(content);

    // Transplanting ciphertext into another conversation fails GCM auth.
    const transplanted = { content: stored };
    expect(() =>
      decryptIncognitoMessageRow(transplanted, {
        dek,
        conversationId: CONVERSATION_B,
      }),
    ).toThrow();

    // The wrong DEK fails outright.
    expect(() =>
      decryptIncognitoMessageRow(
        { content: stored },
        { dek: randomBytes(32), conversationId: CONVERSATION_A },
      ),
    ).toThrow();
  });
});

describe("incognito escrow (enterprise)", () => {
  beforeEach(() => {
    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = ESCROW_PEM;
  });

  test("escrow is configured only with both an EE license and a valid key", () => {
    expect(isIncognitoEscrowConfigured()).toBe(true);

    config.enterpriseFeatures.core = false;
    expect(isIncognitoEscrowConfigured()).toBe(false);

    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = undefined;
    expect(isIncognitoEscrowConfigured()).toBe(false);
  });

  test("boot guard rejects a key without a license, bad PEMs, and small keys", () => {
    expect(() => verifyIncognitoChatConfig()).not.toThrow();

    config.enterpriseFeatures.core = false;
    expect(() => verifyIncognitoChatConfig()).toThrow(/enterprise license/);

    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = "not-a-pem";
    expect(() => verifyIncognitoChatConfig()).toThrow();

    // Static throwaway 1024-bit public key: exists only to exercise the
    // too-small rejection path (generating one at runtime trips security
    // scanners on the weak-key-creation API).
    config.chatIncognito.escrowPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCuijYqImrbeLGs83Xm0Fu8aqas
huvm2Xtra8nyKmJ/+agBugefYnrCSkhoZ6nnVVJWFkELzcempfxJ2sMrlZIm+fXl
c9tWbk/SWCgWHRZ9sT8EpmU4/mcWkeEOdVMM9NJaX4rEZ3qAlQ5WOnipnRMUg6cK
kt2mqWURg9/ZzdQ7GwIDAQAB
-----END PUBLIC KEY-----`;
    expect(() => verifyIncognitoChatConfig()).toThrow(/at least 2048 bits/);

    // Non-RSA keys are rejected by type, not size.
    const ec = generateKeyPairSync("ed25519");
    config.chatIncognito.escrowPublicKey = ec.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    expect(() => verifyIncognitoChatConfig()).toThrow(/must be an RSA/);

    // Unset is always fine — the free feature runs without escrow.
    config.chatIncognito.escrowPublicKey = undefined;
    expect(() => verifyIncognitoChatConfig()).not.toThrow();
  });

  test("boot guard names each missing piece for the vault sink", () => {
    config.chatIncognito.escrowSink = "vault";

    // Missing license.
    config.enterpriseFeatures.core = false;
    expect(() => verifyIncognitoChatConfig()).toThrow(/enterprise license/);

    // Missing escrow key.
    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = undefined;
    expect(() => verifyIncognitoChatConfig()).toThrow(
      /ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY/,
    );

    // Missing Vault secrets backend.
    config.chatIncognito.escrowPublicKey = ESCROW_PEM;
    config.secretsManager.type = "DB";
    expect(() => verifyIncognitoChatConfig()).toThrow(
      /ARCHESTRA_SECRETS_MANAGER=Vault/,
    );

    // All three present: fine.
    config.secretsManager.type = "VAULT";
    expect(() => verifyIncognitoChatConfig()).not.toThrow();
  });

  test("escrow wrap is independently recoverable with the private key", () => {
    const dek = randomBytes(32);
    const blob = wrapIncognitoDek(dek);

    expect(blob.v).toBe(1);
    expect(blob.alg).toBe("RSA-OAEP-256");
    // The exact recovery contract customers' offline tooling relies on:
    // RSA-OAEP with SHA-256 over the base64 blob.
    const recovered = privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(blob.wrappedDek, "base64"),
    );
    expect(recovered.equals(dek)).toBe(true);
  });

  test("produceIncognitoEscrow returns the inline blob for the db sink", async () => {
    const dek = randomBytes(32);
    const record = await produceIncognitoEscrow({
      dek,
      conversationId: CONVERSATION_A,
    });
    expect(record).toMatchObject({ v: 1, alg: "RSA-OAEP-256" });
  });
});
