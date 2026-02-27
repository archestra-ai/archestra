import { describe, expect, test } from "vitest";
import config from "@/config";
import {
  _resetCachedKey,
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedSecret,
} from "./crypto";

describe("encryptSecretValue / decryptSecretValue", () => {
  test("round-trips a simple object", () => {
    const plaintext = { apiKey: "sk-test-123" };
    const encrypted = encryptSecretValue(plaintext);
    const decrypted = decryptSecretValue(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  test("round-trips an empty object", () => {
    const plaintext = {};
    const encrypted = encryptSecretValue(plaintext);
    const decrypted = decryptSecretValue(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  test("round-trips nested objects", () => {
    const plaintext = {
      oauth: { access_token: "abc", refresh_token: "def" },
      nested: { deep: { value: 42 } },
    };
    const encrypted = encryptSecretValue(plaintext);
    const decrypted = decryptSecretValue(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  test("produces different ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = { key: "value" };
    const a = encryptSecretValue(plaintext);
    const b = encryptSecretValue(plaintext);
    expect(a.__encrypted).not.toBe(b.__encrypted);
  });

  test("encrypted value has correct format", () => {
    const encrypted = encryptSecretValue({ test: true });
    expect(encrypted).toHaveProperty("__encrypted");
    expect(encrypted.__encrypted).toMatch(
      /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
    );
  });

  test("throws on tampered ciphertext", () => {
    const encrypted = encryptSecretValue({ key: "value" });
    const parts = encrypted.__encrypted.split(":");
    // Tamper with the ciphertext portion
    parts[3] = `${parts[3]}AAAA`;
    encrypted.__encrypted = parts.join(":");
    expect(() => decryptSecretValue(encrypted)).toThrow();
  });

  test("throws on tampered auth tag", () => {
    const encrypted = encryptSecretValue({ key: "value" });
    const parts = encrypted.__encrypted.split(":");
    // Replace auth tag with garbage
    parts[2] = "AAAAAAAAAAAAAAAAAAAAAA";
    encrypted.__encrypted = parts.join(":");
    expect(() => decryptSecretValue(encrypted)).toThrow();
  });

  test("throws on invalid format (missing parts)", () => {
    expect(() => decryptSecretValue({ __encrypted: "v1:abc" })).toThrow(
      "Invalid encrypted secret format",
    );
  });

  test("throws on invalid version prefix", () => {
    expect(() => decryptSecretValue({ __encrypted: "v2:a:b:c" })).toThrow(
      "Invalid encrypted secret format",
    );
  });
});

describe("isEncryptedSecret", () => {
  test("returns true for encrypted values", () => {
    const encrypted = encryptSecretValue({ key: "value" });
    expect(isEncryptedSecret(encrypted)).toBe(true);
  });

  test("returns false for plain objects", () => {
    expect(isEncryptedSecret({ apiKey: "sk-123" })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isEncryptedSecret(null)).toBe(false);
  });

  test("returns false for non-objects", () => {
    expect(isEncryptedSecret("string")).toBe(false);
    expect(isEncryptedSecret(42)).toBe(false);
  });

  test("returns false for wrong version prefix", () => {
    expect(isEncryptedSecret({ __encrypted: "v2:a:b:c" })).toBe(false);
  });

  test("returns false for non-string __encrypted", () => {
    expect(isEncryptedSecret({ __encrypted: 123 })).toBe(false);
  });
});

describe("key management", () => {
  test("throws when auth secret is not set", () => {
    _resetCachedKey();

    const original = config.auth.secret;
    config.auth.secret = undefined;

    try {
      expect(() => encryptSecretValue({ key: "value" })).toThrow(
        "ARCHESTRA_AUTH_SECRET is required",
      );
    } finally {
      config.auth.secret = original;
      _resetCachedKey();
    }
  });

  test("decryption fails with a different key", () => {
    const encrypted = encryptSecretValue({ key: "value" });

    // Change the secret to simulate key rotation without re-encryption
    _resetCachedKey();
    const original = config.auth.secret;
    config.auth.secret = "a-completely-different-secret-key-value-here";

    try {
      expect(() => decryptSecretValue(encrypted)).toThrow();
    } finally {
      config.auth.secret = original;
      _resetCachedKey();
    }
  });
});
