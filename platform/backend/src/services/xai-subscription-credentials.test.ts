import { describe, expect, it } from "vitest";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
  isXaiSubscriptionCredential,
} from "./xai-subscription-credentials";

describe("xai subscription credential codec", () => {
  it("round-trips a credential through encode/decode", () => {
    const encoded = encodeXaiSubscriptionCredential({
      refreshToken: "rt_secret",
      userId: "user_123",
      email: "user@example.com",
    });
    expect(isXaiSubscriptionCredential(encoded)).toBe(true);
    expect(decodeXaiSubscriptionCredential(encoded)).toEqual({
      refreshToken: "rt_secret",
      userId: "user_123",
      email: "user@example.com",
    });
  });

  it("treats plain API keys as non-subscription credentials", () => {
    expect(isXaiSubscriptionCredential("xai-plain-key")).toBe(false);
    expect(decodeXaiSubscriptionCredential("xai-plain-key")).toBeNull();
    expect(isXaiSubscriptionCredential(undefined)).toBe(false);
  });

  it("returns null when the marker is present but the payload is malformed", () => {
    expect(
      decodeXaiSubscriptionCredential("xai-subscription:not-base64!!"),
    ).toBeNull();
    const empty = `xai-subscription:${Buffer.from(
      JSON.stringify({ refreshToken: "", userId: "" }),
    ).toString("base64")}`;
    expect(decodeXaiSubscriptionCredential(empty)).toBeNull();
  });

  it("refuses to encode an empty refresh token or user id", () => {
    // Failing here beats minting a valid-looking key that only breaks at
    // request time.
    expect(() =>
      encodeXaiSubscriptionCredential({ refreshToken: "", userId: "user" }),
    ).toThrow();
    expect(() =>
      encodeXaiSubscriptionCredential({ refreshToken: "rt", userId: "" }),
    ).toThrow();
  });
});
