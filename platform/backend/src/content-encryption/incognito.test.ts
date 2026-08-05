// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { isContentEnvelope } from "./index.ee";
import {
  decryptIncognitoMessageRow,
  encryptIncognitoMessageContent,
  incognitoDekFingerprint,
  incognitoDekMatches,
  isIncognitoChatEnabled,
  parseIncognitoDekHeader,
  verifyIncognitoChatConfig,
  wrapIncognitoDek,
} from "./incognito.ee";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const CONVERSATION_A = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_B = "22222222-2222-4222-8222-222222222222";

describe("incognito chat crypto", () => {
  beforeEach(() => {
    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = ESCROW_PEM;
  });

  test("enabled only with both an EE license and a valid escrow key", () => {
    expect(isIncognitoChatEnabled()).toBe(true);

    config.enterpriseFeatures.core = false;
    expect(isIncognitoChatEnabled()).toBe(false);

    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = undefined;
    expect(isIncognitoChatEnabled()).toBe(false);
  });

  test("boot guard rejects a key without a license, bad PEMs, and small keys", () => {
    expect(() => verifyIncognitoChatConfig()).not.toThrow();

    config.enterpriseFeatures.core = false;
    expect(() => verifyIncognitoChatConfig()).toThrow(/enterprise license/);

    config.enterpriseFeatures.core = true;
    config.chatIncognito.escrowPublicKey = "not-a-pem";
    expect(() => verifyIncognitoChatConfig()).toThrow();

    const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
    config.chatIncognito.escrowPublicKey = small.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    expect(() => verifyIncognitoChatConfig()).toThrow(/at least 2048 bits/);

    // Non-RSA keys are rejected by type, not size.
    const ec = generateKeyPairSync("ed25519");
    config.chatIncognito.escrowPublicKey = ec.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    expect(() => verifyIncognitoChatConfig()).toThrow(/must be an RSA/);

    // Unset is always fine — the feature is simply off.
    config.chatIncognito.escrowPublicKey = undefined;
    expect(() => verifyIncognitoChatConfig()).not.toThrow();
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

  test("message content roundtrips; AAD rejects cross-conversation transplant", () => {
    const dek = randomBytes(32);
    const content = { id: "m1", role: "user", parts: [{ type: "text", text: "secret" }] };

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
