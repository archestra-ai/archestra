import { beforeEach, describe, expect, test, vi } from "vitest";
import OpenAppaNativeRoomModel from "@/models/openappa-native-room";
import type { OpenAppaSession } from "@/openappa/service";

const dispatch = vi.hoisted(() => vi.fn());
const active = vi.hoisted(() => vi.fn(async () => true));
const unenforced = vi.hoisted(() => vi.fn(async () => false));

vi.mock("@/openappa/service", () => ({
  nativeGuardrailsActive: active,
  startOpenappaSession: vi.fn(async () => {}),
  dispatchOpenappaEvent: dispatch,
}));

vi.mock("@/openappa/unenforced", () => ({
  startedUnenforced: unenforced,
}));

import type { NativeRoomFacts } from "./native-contract";
import { admitNativeIngress, authorizeNativeEgress } from "./native-message";

const session: OpenAppaSession = {
  organization_id: "org-native",
  caller_id: "user:host",
  session_id: "session-native",
};

const facts: NativeRoomFacts = {
  ref: {
    provider: "outlook",
    workspaceId: "mailbox",
    channelId: "thread",
    threadId: "",
  },
  trust: "suspicious",
  readers: { status: "resolved", emails: ["alice@example.com"] },
};

function allowThenAck(approved: string, source: "tool" | "runtime" = "tool") {
  dispatch
    .mockResolvedValueOnce({ decision: "allow_call" })
    .mockResolvedValueOnce({
      decision: "ack",
      approved_output: approved,
      output_source: source,
    });
}

describe("native ingress and egress", () => {
  beforeEach(() => {
    dispatch.mockReset();
    active.mockResolvedValue(true);
    unenforced.mockResolvedValue(false);
  });

  test("a runtime replacement is returned and the rejected body is not", async () => {
    allowThenAck("sanitized", "runtime");
    const admitted = await admitNativeIngress({
      session,
      eventId: "msg-1",
      facts,
      parts: [{ id: "", content: "raw secret" }],
    });
    expect(admitted).toEqual({
      decision: "admitted",
      parts: [{ id: "", text: "sanitized", outputSource: "runtime" }],
    });
    expect(JSON.stringify(admitted)).not.toContain("raw secret");
    expect(dispatch.mock.calls).toHaveLength(2);
    for (const [, event] of dispatch.mock.calls) {
      expect(event).toHaveProperty("native_boundary", true);
    }
  });

  test("a refusal returns no text", async () => {
    dispatch.mockResolvedValueOnce({
      decision: "refuse",
      detail: "consult failed",
    });
    const refused = await admitNativeIngress({
      session,
      eventId: "msg-2",
      facts,
      parts: [{ id: "", content: "raw secret" }],
    });
    expect(refused).toEqual({ decision: "refused", reason: "consult" });
    expect(JSON.stringify(refused)).not.toContain("raw secret");
  });

  test("a different body under the same event id is a conflict and is not admitted", async () => {
    dispatch.mockRejectedValueOnce(
      new Error("receipt key was reused with different input"),
    );
    const conflict = await admitNativeIngress({
      session,
      eventId: "msg-3",
      facts,
      parts: [{ id: "", content: "new body" }],
    });
    expect(conflict).toEqual({ decision: "refused", reason: "conflict" });
    expect(JSON.stringify(conflict)).not.toContain("new body");
  });

  test("a replay returns the stored approved bytes, not the new input", async () => {
    allowThenAck("stored approved");
    const replay = await admitNativeIngress({
      session,
      eventId: "msg-4",
      facts,
      parts: [{ id: "", content: "caller retry body" }],
    });
    expect(replay).toEqual({
      decision: "admitted",
      parts: [{ id: "", text: "stored approved", outputSource: "runtime" }],
    });
    expect(JSON.stringify(replay)).not.toContain("caller retry body");
  });

  test("an off deployment does not dispatch or register a snapshot", async () => {
    active.mockResolvedValue(false);
    const skipped = await admitNativeIngress({
      session,
      eventId: "msg-off",
      facts,
      parts: [{ id: "", content: "leave me" }],
    });
    expect(skipped).toEqual({ decision: "not_governed", reason: "disabled" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a completed send is not authorized again", async () => {
    dispatch.mockResolvedValueOnce({ decision: "allow_call" });
    const first = await authorizeNativeEgress({
      session,
      eventId: "send-1",
      facts,
      content: "reply",
    });
    expect(first.decision).toBe("allowed");
    if (first.decision !== "allowed") return;
    dispatch.mockResolvedValueOnce({ decision: "ack" });
    await first.complete("success");
    dispatch.mockClear();
    const replay = await authorizeNativeEgress({
      session,
      eventId: "send-1",
      facts,
      content: "reply",
    });
    expect(replay).toEqual({ decision: "already_delivered" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("concurrent retries cannot acquire two delivery grants", async () => {
    dispatch.mockResolvedValue({ decision: "allow_call" });
    const request = {
      session,
      eventId: "send-concurrent",
      facts,
      content: "reply",
    };
    const decisions = await Promise.all([
      authorizeNativeEgress(request),
      authorizeNativeEgress(request),
    ]);
    expect(
      decisions.filter((decision) => decision.decision === "allowed"),
    ).toHaveLength(1);
    expect(
      decisions.filter((decision) => decision.decision === "refused"),
    ).toHaveLength(1);
    await expect(authorizeNativeEgress(request)).resolves.toEqual({
      decision: "refused",
      reason: "conflict",
    });
  });

  test("completion is once-only and a receipt failure cannot resend a successful delivery", async () => {
    dispatch.mockResolvedValueOnce({ decision: "allow_call" });
    const request = {
      session,
      eventId: "send-receipt-error",
      facts,
      content: "reply",
    };
    const grant = await authorizeNativeEgress(request);
    expect(grant.decision).toBe("allowed");
    if (grant.decision !== "allowed") return;
    dispatch.mockRejectedValueOnce(new Error("Runtime unavailable"));
    await expect(grant.complete("success")).rejects.toThrow(
      "Runtime unavailable",
    );
    await expect(grant.complete("failure")).rejects.toThrow("already started");
    await expect(authorizeNativeEgress(request)).resolves.toEqual({
      decision: "already_delivered",
    });
    await expect(
      authorizeNativeEgress({ ...request, content: "changed" }),
    ).resolves.toEqual({
      decision: "refused",
      reason: "conflict",
    });
  });

  test("a failed send remains blocked rather than receiving a fresh grant", async () => {
    dispatch.mockResolvedValueOnce({ decision: "allow_call" });
    const request = {
      session,
      eventId: "send-failed",
      facts,
      content: "reply",
    };
    const grant = await authorizeNativeEgress(request);
    expect(grant.decision).toBe("allowed");
    if (grant.decision !== "allowed") return;
    dispatch.mockResolvedValueOnce({ decision: "ack" });
    await grant.complete("failure");
    await expect(authorizeNativeEgress(request)).resolves.toEqual({
      decision: "refused",
      reason: "conflict",
    });
  });

  test("a denied send does not record a delivery", async () => {
    dispatch.mockResolvedValueOnce({
      decision: "deny_call",
      feedback: "allowed readers would not cover the destination",
      offers: [{ offer_id: "aaaaaaaaaaaaaaaa" }],
    });
    const denied = await authorizeNativeEgress({
      session,
      eventId: "send-2",
      facts,
      content: "do not send",
    });
    expect(denied.decision).toBe("refused");
    expect(
      await OpenAppaNativeRoomModel.findDelivery({
        organizationId: session.organization_id,
        sessionId: session.session_id,
        eventId: "send-2",
      }),
    ).toBeNull();
  });

  test.each([
    { emails: [] },
    { emails: ["alice@example.com", ""] },
    { emails: ["alice@example.com", "unknown"] },
  ])("never silently shrinks an incomplete resolved audience: $emails", async ({
    emails,
  }) => {
    const decision = await authorizeNativeEgress({
      session,
      eventId: "send-invalid-audience",
      facts: { ...facts, readers: { status: "resolved", emails } },
      content: "reply",
    });
    expect(decision).toEqual({ decision: "refused", reason: "consult" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("unresolved readers are stored as unknown, not an empty list", async () => {
    dispatch.mockResolvedValueOnce({ decision: "allow_call" });
    dispatch.mockResolvedValueOnce({
      decision: "ack",
      approved_output: "public",
      output_source: "tool",
    });
    const admitted = await admitNativeIngress({
      session,
      eventId: "msg-public",
      facts: { ...facts, readers: { status: "unresolved" } },
      parts: [{ id: "", content: "public" }],
    });
    expect(admitted.decision).toBe("admitted");
    const call = dispatch.mock.calls[0]?.[1] as { arguments: string };
    const roomId = JSON.parse(call.arguments).room_id as string;
    const stored = await OpenAppaNativeRoomModel.findByRoomId(roomId);
    expect(stored?.readers).toEqual({ status: "unresolved" });
  });
});
