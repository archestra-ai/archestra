import { describe, expect, test } from "vitest";
import { encodeSignedToolCallId } from "@/routes/proxy/adapters/gemini-openai-translator";
import { policyCallId } from "./call-id";
import { stampToolCallId } from "./trajectory-stamp";

// The id the Gemini translation hands a client: the call's thought signature
// rides inside it, so it outgrows every limit a call's identity has.
const geminiId = encodeSignedToolCallId({
  id: "gemini-call-read-1",
  name: "read",
  thoughtSignature: "s".repeat(1500),
});

function stamped(callId: string): string {
  return stampToolCallId({
    callId,
    sessionId: "session",
    organizationId: "organization",
    callerId: "user:user",
    secret: "secret",
  });
}

describe("policyCallId", () => {
  test("keeps an id of up to 256 bytes, stamped or not", () => {
    expect(policyCallId("call_abc")).toBe("call_abc");
    expect(policyCallId("c".repeat(256))).toBe("c".repeat(256));
    expect(policyCallId(stamped("c".repeat(256)))).toBe(
      stamped("c".repeat(256)),
    );
  });

  test("names a longer id by the same digest on every turn", () => {
    expect(Buffer.byteLength(geminiId)).toBeGreaterThan(1024);
    const policyId = policyCallId(geminiId);
    expect(policyId).toMatch(/^call_[0-9a-f]{32}$/);
    expect(policyCallId(geminiId)).toBe(policyId);
    expect(policyCallId(`${geminiId}x`)).not.toBe(policyId);
  });

  test("measures bytes, not characters", () => {
    expect(policyCallId("é".repeat(128))).toBe("é".repeat(128));
    expect(policyCallId("é".repeat(129))).toMatch(/^call_[0-9a-f]{32}$/);
  });

  test("gives a stamped id the policy id of the call inside", () => {
    expect(policyCallId(stamped(geminiId))).toBe(policyCallId(geminiId));
  });

  test("leaves a policy id as it is", () => {
    expect(policyCallId(policyCallId(geminiId))).toBe(policyCallId(geminiId));
  });
});
