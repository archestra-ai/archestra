import {
  constants as cryptoConstants,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import { isContentEnvelope } from "@/utils/crypto";
import {
  decryptEncryptedChatMessageRow,
  decryptEncryptedChatValue,
  encryptEncryptedChatMessageContent,
  encryptEncryptedChatValue,
  encryptedChatDekFingerprint,
  encryptedChatDekMatches,
  isEncryptedChatEnabled,
  parseEncryptedChatDekHeader,
} from "./encrypted-chat";
import {
  isEncryptedChatEscrowConfigured,
  verifyEncryptedChatConfig,
  wrapEncryptedChatDek,
} from "./encrypted-chat-escrow";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const ESCROW_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const CONVERSATION_A = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_B = "22222222-2222-4222-8222-222222222222";

describe("encrypted chat crypto", () => {
  test("the escrow key is the only enablement switch", () => {
    // No escrow key: the audit trail these conversations produce would be
    // encrypted under a key only one browser holds, so the feature is OFF.
    config.enterpriseFeatures.core = false;
    config.encryptedChat.escrowPublicKey = undefined;
    expect(isEncryptedChatEnabled()).toBe(false);

    // An escrow key alone turns it on — the db sink needs no enterprise
    // license, so this is the unlicensed posture.
    config.encryptedChat.escrowPublicKey = ESCROW_PEM;
    expect(isEncryptedChatEnabled()).toBe(true);

    // Removing it turns the feature off again; there is no second flag.
    config.encryptedChat.escrowPublicKey = undefined;
    expect(isEncryptedChatEnabled()).toBe(false);
  });

  test("DEK header parsing enforces exactly 32 base64url bytes", () => {
    expect(parseEncryptedChatDekHeader(undefined)).toBeNull();
    expect(parseEncryptedChatDekHeader("")).toBeNull();

    const dek = randomBytes(32);
    const parsed = parseEncryptedChatDekHeader(dek.toString("base64url"));
    expect(parsed?.equals(dek)).toBe(true);

    expect(() =>
      parseEncryptedChatDekHeader(randomBytes(16).toString("base64url")),
    ).toThrow(/32 bytes/);
  });

  test("fingerprints bind to the conversation and compare correctly", () => {
    const dek = randomBytes(32);
    const fp = encryptedChatDekFingerprint(CONVERSATION_A, dek);

    expect(
      encryptedChatDekMatches({
        storedFingerprint: fp,
        conversationId: CONVERSATION_A,
        dek,
      }),
    ).toBe(true);
    // Same DEK, different conversation: no match (fingerprints don't leak
    // cross-conversation key reuse).
    expect(
      encryptedChatDekMatches({
        storedFingerprint: fp,
        conversationId: CONVERSATION_B,
        dek,
      }),
    ).toBe(false);
    expect(
      encryptedChatDekMatches({
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

    const stored = encryptEncryptedChatMessageContent(content, {
      dek,
      conversationId: CONVERSATION_A,
    });
    // Same envelope shape as the at-rest layer — the backfill sweep must see
    // it as an envelope (and skip it as foreign-key), never as plaintext.
    expect(isContentEnvelope(stored)).toBe(true);

    const row = { content: stored };
    decryptEncryptedChatMessageRow(row, {
      dek,
      conversationId: CONVERSATION_A,
    });
    expect(row.content).toEqual(content);

    // Transplanting ciphertext into another conversation fails GCM auth.
    const transplanted = { content: stored };
    expect(() =>
      decryptEncryptedChatMessageRow(transplanted, {
        dek,
        conversationId: CONVERSATION_B,
      }),
    ).toThrow();

    // The wrong DEK fails outright.
    expect(() =>
      decryptEncryptedChatMessageRow(
        { content: stored },
        { dek: randomBytes(32), conversationId: CONVERSATION_A },
      ),
    ).toThrow();
  });

  test("audit-column values roundtrip, including arrays and primitives", () => {
    const dek = randomBytes(32);
    const key = { dek, conversationId: CONVERSATION_A };

    for (const value of [
      { model: "claude", messages: [{ role: "user", content: "secret ask" }] },
      [1, "two", { three: 3 }],
      "a bare string",
      0,
      false,
    ]) {
      const stored = encryptEncryptedChatValue(value, {
        ...key,
        context: "interactions.request",
      });
      // Envelope-shaped exactly like the at-rest layer's, so the backfill
      // sweep recognizes (and skips) it.
      expect(isContentEnvelope(stored)).toBe(true);
      expect(
        decryptEncryptedChatValue(stored, {
          ...key,
          context: "interactions.request",
        }),
      ).toEqual(value);
    }
  });

  test("AAD binds an audit envelope to its column and its conversation", () => {
    const dek = randomBytes(32);
    const stored = encryptEncryptedChatValue(
      { messages: ["the request"] },
      { dek, conversationId: CONVERSATION_A, context: "interactions.request" },
    );

    // Same DEK, same conversation, WRONG column: a database-level writer
    // cannot move a request into the response column.
    expect(() =>
      decryptEncryptedChatValue(stored, {
        dek,
        conversationId: CONVERSATION_A,
        context: "interactions.response",
      }),
    ).toThrow();

    // Same column, WRONG conversation: a leaked DEK shared between two
    // conversations still cannot open the other one's rows.
    expect(() =>
      decryptEncryptedChatValue(stored, {
        dek,
        conversationId: CONVERSATION_B,
        context: "interactions.request",
      }),
    ).toThrow();
  });

  test("messages.content AAD is unchanged by the generalized helpers", () => {
    // Backward compatibility for rows written before the audit surfaces were
    // generalized: the message helper and the generic helper must agree on
    // the AAD, or every stored encrypted-chat message becomes unreadable.
    const dek = randomBytes(32);
    const content = { id: "m1", parts: [{ type: "text", text: "secret" }] };

    const stored = encryptEncryptedChatMessageContent(content, {
      dek,
      conversationId: CONVERSATION_A,
    });
    expect(
      decryptEncryptedChatValue(stored, {
        dek,
        conversationId: CONVERSATION_A,
        context: "messages.content",
      }),
    ).toEqual(content);
  });
});

describe("encrypted chat escrow", () => {
  beforeEach(() => {
    config.enterpriseFeatures.core = true;
    config.encryptedChat.escrowPublicKey = ESCROW_PEM;
  });

  test("escrow is configured by a valid key alone — no license needed", () => {
    expect(isEncryptedChatEscrowConfigured()).toBe(true);

    // The default `db` sink is a free feature.
    config.enterpriseFeatures.core = false;
    expect(isEncryptedChatEscrowConfigured()).toBe(true);

    config.enterpriseFeatures.core = true;
    config.encryptedChat.escrowPublicKey = undefined;
    expect(isEncryptedChatEscrowConfigured()).toBe(false);
  });

  test("boot guard accepts an unlicensed db-sink key, rejects bad PEMs and small keys", () => {
    expect(() => verifyEncryptedChatConfig()).not.toThrow();

    // A valid key with no license is the ordinary free configuration.
    config.enterpriseFeatures.core = false;
    expect(() => verifyEncryptedChatConfig()).not.toThrow();

    config.enterpriseFeatures.core = true;
    config.encryptedChat.escrowPublicKey = "not-a-pem";
    expect(() => verifyEncryptedChatConfig()).toThrow();

    // Static throwaway 1024-bit public key: exists only to exercise the
    // too-small rejection path (generating one at runtime trips security
    // scanners on the weak-key-creation API).
    config.encryptedChat.escrowPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCuijYqImrbeLGs83Xm0Fu8aqas
huvm2Xtra8nyKmJ/+agBugefYnrCSkhoZ6nnVVJWFkELzcempfxJ2sMrlZIm+fXl
c9tWbk/SWCgWHRZ9sT8EpmU4/mcWkeEOdVMM9NJaX4rEZ3qAlQ5WOnipnRMUg6cK
kt2mqWURg9/ZzdQ7GwIDAQAB
-----END PUBLIC KEY-----`;
    expect(() => verifyEncryptedChatConfig()).toThrow(/at least 2048 bits/);

    // Non-RSA keys are rejected by type, not size.
    const ec = generateKeyPairSync("ed25519");
    config.encryptedChat.escrowPublicKey = ec.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    expect(() => verifyEncryptedChatConfig()).toThrow(/must be an RSA/);

    // Unset boots fine — the feature is simply unavailable.
    config.encryptedChat.escrowPublicKey = undefined;
    expect(() => verifyEncryptedChatConfig()).not.toThrow();
  });

  test("rotating the escrow key changes the recorded fingerprint, so recovery knows which private key to use", () => {
    // Rotation is forward-only: rows already written stay wrapped to the key
    // configured when they were created. The fingerprint on the blob is the
    // only thing telling a break-glass operator which private key opens which
    // row, so it has to track the key actually used.
    const first = wrapEncryptedChatDek(randomBytes(32));

    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    config.encryptedChat.escrowPublicKey = rotated.publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    const second = wrapEncryptedChatDek(randomBytes(32));

    expect(second.escrowKeyFingerprint).not.toBe(first.escrowKeyFingerprint);
    // The pre-rotation blob still opens with the pre-rotation private key.
    expect(() =>
      privateDecrypt(
        {
          key: privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(first.wrappedDek, "base64"),
      ),
    ).not.toThrow();
    // ...and the rotated key cannot open it.
    expect(() =>
      privateDecrypt(
        {
          key: rotated.privateKey,
          padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(first.wrappedDek, "base64"),
      ),
    ).toThrow();
  });

  test("escrow wrap is independently recoverable with the private key", () => {
    const dek = randomBytes(32);
    const blob = wrapEncryptedChatDek(dek);

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
});
