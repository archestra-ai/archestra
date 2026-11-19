import { describe, expect, test } from "vitest";
import { WireCallIds } from "./wire-call-ids";

const longId = `gemsig-${"s".repeat(2000)}.gemini-call-read-1`;
const policyId = "gemini-call-read-1";
const proof = {
  name: "read",
  action: "read",
  session: { organization_id: "organization", session_id: "session" },
  spawn: false,
  wrapped: false,
};

describe("WireCallIds", () => {
  test("leaves calls alone when every id fits", () => {
    const ids = new WireCallIds();
    const call = { id: "call_abc", name: "read", arguments: "{}" };
    expect(ids.toolCall(call)).toBe(call);
    expect(ids.same).toBe(true);
  });

  test("puts a long id's call under its policy id and carries the wire id", () => {
    const ids = new WireCallIds();
    expect(ids.toolCall({ id: longId, name: "read", arguments: "{}" })).toEqual(
      { id: policyId, name: "read", arguments: "{}", wireId: longId },
    );
    expect(ids.same).toBe(false);
  });

  test("hands released calls back under the ids the wire carries", () => {
    const ids = new WireCallIds();
    const call = ids.toolCall({ id: longId, name: "read", arguments: "{}" });
    const short = { id: "call_abc", name: "list", arguments: "{}" };
    expect(
      ids.toolCallsOutcome({
        decision: "allow",
        toolCalls: [
          call,
          short,
          // A notice is built anew: it never had the wire id.
          { id: policyId, name: "notice", arguments: "{}" },
          { ...call, wireId: "appat1-stamp" },
        ],
        blocked: [{ id: policyId, name: "read", reason: "no" }],
        rewritten: [{ id: policyId, name: "read" }],
        annotated: [
          { id: policyId, name: "read", field: "prompt", appended: "marker" },
        ],
        runtimeProofs: [{ ...proof, id: policyId }],
      }),
    ).toEqual({
      decision: "allow",
      toolCalls: [
        { id: longId, name: "read", arguments: "{}" },
        short,
        { id: longId, name: "notice", arguments: "{}" },
        { id: longId, name: "read", arguments: "{}", wireId: "appat1-stamp" },
      ],
      blocked: [{ id: longId, name: "read", reason: "no" }],
      rewritten: [{ id: longId, name: "read" }],
      annotated: [
        { id: longId, name: "read", field: "prompt", appended: "marker" },
      ],
      runtimeProofs: [{ ...proof, id: longId }],
    });
  });

  test("names a refused call by the id the wire carries", () => {
    const ids = new WireCallIds();
    ids.toolCall({ id: longId, name: "read", arguments: "{}" });
    const refusal = {
      refusalMessage: "no",
      contentMessage: "no",
      reason: "openappa_no_notice_tool",
      blockedToolName: "read",
      toolInput: {},
      allToolCallNames: ["read"],
    };
    expect(
      ids.toolCallsOutcome({
        decision: "refuse",
        refusal: { ...refusal, blockedToolId: policyId },
      }),
    ).toEqual({
      decision: "refuse",
      refusal: { ...refusal, blockedToolId: longId },
    });
  });

  test("hands hosted notices back under the ids the wire carries", () => {
    const ids = new WireCallIds();
    expect(
      ids.hostedToolCall({
        id: longId,
        name: "web_search",
        arguments: {},
        output: "found",
      }).id,
    ).toBe(policyId);
    expect(
      ids.hostedToolCallsOutcome({
        decision: "hold",
        notices: [{ id: policyId, name: "notice", arguments: "{}" }],
        blocked: [{ id: policyId, name: "web_search", reason: "no" }],
      }),
    ).toEqual({
      decision: "hold",
      notices: [{ id: longId, name: "notice", arguments: "{}" }],
      blocked: [{ id: longId, name: "web_search", reason: "no" }],
    });
  });

  test("keys result updates by the ids the request carries", () => {
    const ids = new WireCallIds();
    expect(
      ids.toolResult({
        id: longId,
        name: "read",
        content: "text",
        isError: false,
      }).id,
    ).toBe(policyId);
    expect(
      ids.toolResultsOutcome({
        toolResultUpdates: { [policyId]: "withheld", call_abc: "kept" },
      }),
    ).toEqual({
      toolResultUpdates: { [longId]: "withheld", call_abc: "kept" },
    });
  });
});
