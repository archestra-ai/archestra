import { describe, expect, test } from "vitest";
import { encodeSignedToolCallId } from "@/routes/proxy/utils/tool-call-ids";
import { policyCallId, recordedCallId, recordsCall } from "./call-id";
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

  test("knows a Gemini call by Gemini's id, whatever signature rides with it", () => {
    expect(Buffer.byteLength(geminiId)).toBeGreaterThan(1024);
    expect(policyCallId(geminiId)).toBe("gemini-call-read-1");
    expect(
      policyCallId(
        encodeSignedToolCallId({
          id: "gemini-call-read-1",
          name: "read",
          thoughtSignature: "short",
        }),
      ),
    ).toBe("gemini-call-read-1");
    expect(policyCallId(stamped(geminiId))).toBe("gemini-call-read-1");
  });

  test("names any other id over the limit by its digest", () => {
    expect(policyCallId("c".repeat(257))).toBe(
      "call_a76381a76b5d3069cde3a22ac82239c9",
    );
    expect(policyCallId(stamped("c".repeat(257)))).toBe(
      "call_a76381a76b5d3069cde3a22ac82239c9",
    );
    expect(policyCallId(`gemsig-c2ln.${"c".repeat(257)}`)).toBe(
      "call_a76381a76b5d3069cde3a22ac82239c9",
    );
  });

  test("measures bytes, not characters", () => {
    expect(policyCallId("é".repeat(128))).toBe("é".repeat(128));
    expect(policyCallId("é".repeat(129))).toMatch(/^call_[0-9a-f]{32}$/);
  });

  test("leaves a policy id as it is", () => {
    for (const id of [
      geminiId,
      "c".repeat(257),
      `gemsig-YQ.${geminiId}`,
      `gemsig-YQ.${stamped(geminiId)}`,
    ])
      expect(policyCallId(policyCallId(id))).toBe(policyCallId(id));
  });

  test("reads through any depth of signatures", () => {
    expect(policyCallId(`${"gemsig-YQ.".repeat(50_000)}call-1`)).toBe("call-1");
  });
});

describe("recordsCall", () => {
  test("matches a record under the call's recorded id", () => {
    expect(recordedCallId(stamped("call_abc"))).toBe("call_abc");
    expect(recordsCall("call_abc", stamped("call_abc"))).toBe(true);
    expect(recordsCall("gemini-call-read-1", stamped(geminiId))).toBe(true);
    expect(recordsCall("gemini-call-read-2", geminiId)).toBe(false);
  });

  test("matches a record an earlier release kept under the provider's whole id", () => {
    expect(recordsCall("c".repeat(257), stamped("c".repeat(257)))).toBe(true);
    expect(recordsCall(geminiId, geminiId)).toBe(true);
  });
});
