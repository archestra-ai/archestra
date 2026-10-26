import { describe, expect, test } from "vitest";
import {
  openPlainJson,
  openPlainText,
  sealPlainJson,
} from "./plaintext-envelope";

describe("openPlainJson", () => {
  test("reads a value holding a NUL through its plaintext envelope", () => {
    const value = { output: "head\u0000tail", nested: ["a\u0000"] };

    expect(openPlainJson(jsonEnvelope(0, JSON.stringify(value)))).toEqual(
      value,
    );
  });

  test.each([
    { decision: "allow_call" },
    { escaped: "\\u0000" },
    { __appa_encrypted: 1 },
    { __appa_encrypted: "not base64!", other: true },
    ["a"],
    null,
    "text",
  ])("returns any other value as stored: %j", (value) => {
    expect(openPlainJson(value)).toBe(value);
  });

  test("leaves an encrypted envelope as stored", () => {
    const sealed = jsonEnvelope(1, "ciphertext");

    expect(openPlainJson(sealed)).toBe(sealed);
  });

  test("leaves an envelope whose body is not JSON as stored", () => {
    const broken = jsonEnvelope(0, "{not json");

    expect(openPlainJson(broken)).toBe(broken);
  });
});

describe("sealPlainJson", () => {
  test("envelopes a value holding a NUL, in a value or a key, and reads it back", () => {
    for (const value of [
      [{ input: { command: "a\u0000b" } }],
      { "k\u0000": 1 },
      { __appa_encrypted: "looks like an envelope" },
    ]) {
      const sealed = sealPlainJson(value);

      expect(JSON.stringify(sealed)).not.toContain("\\u0000");
      expect(sealed).not.toEqual(value);
      expect(openPlainJson(sealed)).toEqual(value);
    }
  });

  test("stores any other value as it is", () => {
    const value = [{ input: { command: "\\u0000 is six characters" } }];

    expect(sealPlainJson(value)).toBe(value);
  });
});

describe("openPlainText", () => {
  test("reads text holding a NUL through its plaintext envelope", () => {
    expect(openPlainText(textEnvelope(0, "head\u0000tail"))).toBe(
      "head\u0000tail",
    );
  });

  test.each([
    "head tail",
    "appa-storage-v1:not base64!",
    "appa-storage-v1:",
  ])("returns any other text as stored: %s", (text) => {
    expect(openPlainText(text)).toBe(text);
  });

  test("leaves an encrypted envelope and a missing value as stored", () => {
    const sealed = textEnvelope(1, "ciphertext");

    expect(openPlainText(sealed)).toBe(sealed);
    expect(openPlainText(null)).toBe(null);
  });
});

// ===

/** An envelope as OpenAPPA writes it: magic, the mode byte, then the body. */
function envelopeBytes(mode: number, body: string): string {
  return Buffer.concat([
    Buffer.from("\0appa-storage-v1\0", "latin1"),
    Buffer.from([mode]),
    Buffer.from(body, "utf8"),
  ]).toString("base64");
}

function jsonEnvelope(mode: number, body: string) {
  return { __appa_encrypted: envelopeBytes(mode, body) };
}

function textEnvelope(mode: number, body: string): string {
  return `appa-storage-v1:${envelopeBytes(mode, body)}`;
}
