import { describe, expect, test } from "@/test";
import {
  encodeCapabilitySession,
  readCapabilitySession,
} from "./client-capabilities";

describe("capability session ids", () => {
  test("give back what the client declared, only to that caller on that gateway, until they expire", () => {
    const capabilities = { elicitation: { form: {} } };
    const sessionId = encodeCapabilitySession({
      profileId: "gateway-a",
      principal: "user:alice",
      capabilities,
      now: 0,
    });
    if (!sessionId) throw new Error("expected a session id");
    const read = (
      overrides: Partial<Parameters<typeof readCapabilitySession>[0]>,
    ) =>
      readCapabilitySession({
        sessionId,
        profileId: "gateway-a",
        principal: "user:alice",
        now: 1,
        ...overrides,
      });

    expect(read({})).toEqual(capabilities);
    expect(read({ principal: "user:bob" })).toBeUndefined();
    expect(read({ profileId: "gateway-b" })).toBeUndefined();
    expect(read({ now: 31 * 24 * 60 * 60 * 1000 })).toBeUndefined();
    const [payload, signature] = sessionId.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
        u: "user:bob",
      }),
    ).toString("base64url");
    expect(
      read({ sessionId: `${forged}.${signature}`, principal: "user:bob" }),
    ).toBeUndefined();
    expect(read({ sessionId: "not-a-session" })).toBeUndefined();
  });
});
