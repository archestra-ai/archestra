import { describe, expect, test } from "vitest";
import {
  unwrapCompactionCarriersFromRequest,
  wrapCompactionItem,
  wrapCompactionResponse,
} from "./compaction-carrier";

const PROOF =
  "▄█▄▄▄█▄\n██▄█▄██  started subagent ABC-1234\n[appa] child trajectory appact2-c2lnbmVk.cafebabe.";

describe("OpenAPPA opaque compaction carrier", () => {
  test("round-trips the exact ciphertext and full proof", () => {
    const original = "opaque+/=\u0000ciphertext";
    const response = wrapCompactionResponse(
      {
        object: "response.compaction",
        output: [
          { type: "message", content: [] },
          { id: "cmp_1", type: "compaction", encrypted_content: original },
        ],
      },
      PROOF,
    );
    const wrapped = response.output[1]?.encrypted_content;
    const request = {
      input: [
        { type: "message", content: "keep" },
        { type: "compaction", encrypted_content: wrapped },
      ],
    };

    expect(wrapped).toMatch(/^appac1-[A-Za-z0-9_-]+$/);
    expect(unwrapCompactionCarriersFromRequest(request)).toEqual([PROOF]);
    expect(request.input[1]?.encrypted_content).toBe(original);
    expect(request.input[0]).toEqual({ type: "message", content: "keep" });
  });

  test("unwraps one level without interpreting restored ciphertext", () => {
    const inner = encodeCarrier("provider-ciphertext", "older-proof");
    const outer = encodeCarrier(inner, PROOF);
    const request = {
      input: [{ type: "compaction", encrypted_content: outer }],
    };

    expect(unwrapCompactionCarriersFromRequest(request)).toEqual([PROOF]);
    expect(request.input[0]?.encrypted_content).toBe(inner);
  });

  test("leaves malformed and non-canonical lookalikes untouched", () => {
    const nonCanonical = `appac1-${Buffer.from(
      '[ 1, "cipher", "proof" ]',
      "utf8",
    ).toString("base64url")}`;
    const request = {
      input: [
        { type: "compaction", encrypted_content: "appac1-not_base64!" },
        { type: "compaction", encrypted_content: nonCanonical },
      ],
    };

    expect(unwrapCompactionCarriersFromRequest(request)).toEqual([]);
    expect(request.input.map((item) => item.encrypted_content)).toEqual([
      "appac1-not_base64!",
      nonCanonical,
    ]);
  });

  test("does not scan nested objects", () => {
    const wrapped = wrapCompactionItem(
      { type: "compaction", encrypted_content: "cipher" },
      PROOF,
    ).encrypted_content;
    const request = {
      nested: { input: [{ type: "compaction", encrypted_content: wrapped }] },
      input: [{ type: "compaction", encrypted_content: "plain" }],
    };

    expect(unwrapCompactionCarriersFromRequest(request)).toEqual([]);
    expect(request.nested.input[0]?.encrypted_content).toBe(wrapped);
  });

  test("fails closed instead of forwarding more than the carrier bound", () => {
    const wrapped = wrapCompactionItem(
      { type: "compaction", encrypted_content: "cipher" },
      PROOF,
    ).encrypted_content;
    const request = {
      input: Array.from({ length: 65 }, () => ({
        type: "compaction",
        encrypted_content: wrapped,
      })),
    };

    expect(() => unwrapCompactionCarriersFromRequest(request)).toThrow(
      "Too many OpenAI compaction carriers",
    );
  });

  test("keeps repeated output wrapping idempotent", () => {
    const once = wrapCompactionItem(
      { id: "cmp_1", type: "compaction", encrypted_content: "cipher" },
      PROOF,
    );

    expect(wrapCompactionItem(once, PROOF)).toBe(once);
  });

  test("refuses an unbounded proof before producing a carrier", () => {
    expect(() =>
      wrapCompactionItem(
        { type: "compaction", encrypted_content: "cipher" },
        "x".repeat(64 * 1024 + 1),
      ),
    ).toThrow("Invalid OpenAPPA compaction context");
  });
});

function encodeCarrier(encryptedContent: string, proof: string): string {
  return `appac1-${Buffer.from(
    JSON.stringify([1, encryptedContent, proof]),
    "utf8",
  ).toString("base64url")}`;
}
