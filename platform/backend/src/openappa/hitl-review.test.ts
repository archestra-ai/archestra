import { expect, test, vi } from "vitest";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlReview,
  getHitlReviewResult,
  recordHitlReviewResult,
  recordHitlRuling,
  reviewSessionFromTrajectory,
  stageHitlReview,
} from "./hitl-review";
import type { OpenAppaSession } from "./service";

// The real cache, stored in this file's test database.
setupTestCacheManager();

const session = (sessionId: string): OpenAppaSession => ({
  organization_id: "organization",
  caller_id: "user:user",
  session_id: sessionId,
});

test.each([
  ["chat-root", undefined, "user:chat-user"],
  ["foreign-root", undefined, undefined],
  ["chat-root", "parent", undefined],
  ["user:external|root", undefined, "user:external"],
  ["virtual-key:key|root:child", "virtual-key:key|root", "virtual-key:key"],
  [
    "agent-workspace:44444444-4444-4444-8444-444444444444|runtime:child",
    "agent-workspace:44444444-4444-4444-8444-444444444444|runtime",
    "agent-workspace:44444444-4444-4444-8444-444444444444",
  ],
  ["agent-workspace:invalid|runtime", undefined, undefined],
  ["raw-client|root", undefined, undefined],
] as const)("recovers only the established review caller for %s", (sessionId, parentId, callerId) => {
  expect(
    reviewSessionFromTrajectory({
      organizationId: "organization",
      trajectory: {
        session_id: sessionId,
        ...(parentId ? { parent_id: parentId } : {}),
      },
      context: { userId: "chat-user", conversationId: "chat-root" },
    }),
  ).toEqual({
    organization_id: "organization",
    session_id: sessionId,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(callerId ? { caller_id: callerId } : {}),
  });
});

test("binds a ruling to one offer and consumes it once", async () => {
  const first = session("first");
  await stageHitlReview({
    session: first,
    review: {
      offerId: "offer-1",
      text: "Review this call.",
      tool: "mcp/example/write",
      arguments: '{"value":1}',
    },
  });

  expect(
    await recordHitlRuling({
      session: first,
      offerId: "offer-1",
      ruling: "approve",
    }),
  ).toBe(true);
  expect(
    await consumeHitlRuling({ session: first, offerId: "offer-2" }),
  ).toBeUndefined();
  expect(
    await consumeHitlRuling({
      session: session("second"),
      offerId: "offer-1",
    }),
  ).toBeUndefined();
  expect(await consumeHitlRuling({ session: first, offerId: "offer-1" })).toBe(
    "approve",
  );
  expect(
    await consumeHitlRuling({ session: first, offerId: "offer-1" }),
  ).toBeUndefined();
});

test("keeps per-call review history after consuming live approval without reopening it", async () => {
  const active = session("history");
  const lookup = { session: active, callId: "control-1", offerId: "offer-1" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "offer-1", text: "Review this exact call" },
  });
  await recordHitlRuling({
    session: active,
    offerId: "offer-1",
    ruling: "approve",
  });
  expect(await consumeHitlRuling({ session: active, offerId: "offer-1" })).toBe(
    "approve",
  );
  expect(await getHitlReviewResult(lookup)).toBe("review_required");
  expect(await getHitlReview(lookup)).toBeUndefined();
  expect(
    await getHitlAskUserArguments({ session: active, offerIds: ["offer-1"] }),
  ).toBeUndefined();
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "offer-1",
      ruling: "approve",
    }),
  ).toBe(false);
  expect(await consumeHitlRuling(lookup)).toBeUndefined();
  for (const other of [
    { ...lookup, callId: "control-2" },
    { ...lookup, offerId: "offer-2" },
    { ...lookup, session: { ...active, organization_id: "other-org" } },
    { ...lookup, session: { ...active, caller_id: "user:other" } },
    { ...lookup, session: session("other-run") },
    { ...lookup, session: { ...active, parent_id: "other-parent" } },
  ])
    expect(await getHitlReviewResult(other)).toBeUndefined();
});

test("historical status survives review expiry but cannot create an approval", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const active = session("expired-history");
    const lookup = {
      session: active,
      callId: "control-expired",
      offerId: "offer-expired",
    };
    await stageHitlReview({
      ...lookup,
      review: { offerId: lookup.offerId, text: "Pending review" },
    });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await getHitlReview(lookup)).toBeUndefined();
    expect(await getHitlReviewResult(lookup)).toBe("review_required");
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(
      false,
    );
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  "review_unanswered",
  "review_cancelled",
  "review_unavailable",
  "review_invalid",
] as const)("%s history survives expiry without creating a live review or ruling", async (outcome) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const active = session("failed-history");
    const lookup = { session: active, callId: "control-1", offerId: "offer-1" };
    await recordHitlReviewResult({ ...lookup, outcome });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await getHitlReviewResult(lookup)).toBe(outcome);
    expect(await getHitlReviewResult(lookup)).not.toBe("review_required");
    expect(await getHitlReview(lookup)).toBeUndefined();
    expect(await consumeHitlRuling(lookup)).toBeUndefined();
    expect(
      await getHitlAskUserArguments({
        session: active,
        offerIds: [lookup.offerId],
      }),
    ).toBeUndefined();
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(
      false,
    );
    for (const other of [
      { ...lookup, callId: "other-call" },
      { ...lookup, offerId: "other-offer" },
      { ...lookup, session: { ...active, organization_id: "other-org" } },
      { ...lookup, session: { ...active, caller_id: "user:other" } },
      { ...lookup, session: session("other-run") },
      { ...lookup, session: { ...active, parent_id: "other-parent" } },
    ])
      expect(await getHitlReviewResult(other)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("review history expires after thirty days without reviving an approval", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const lookup = {
      session: session("retained-history"),
      callId: "control-retained",
      offerId: "offer-retained",
    };
    const recordedAt = Date.now();
    await recordHitlReviewResult({ ...lookup, outcome: "review_cancelled" });
    vi.setSystemTime(recordedAt + 30 * 24 * 60 * 60 * 1000 - 1);
    expect(await getHitlReviewResult(lookup)).toBe("review_cancelled");
    vi.setSystemTime(Date.now() + 2);
    expect(await getHitlReviewResult(lookup)).toBeUndefined();
    expect(await getHitlReview(lookup)).toBeUndefined();
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(
      false,
    );
    expect(await consumeHitlRuling(lookup)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("an expired approval cannot be consumed or revived by review history", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const active = session("expired-approval");
    const lookup = { session: active, callId: "control-1", offerId: "offer-1" };
    await stageHitlReview({
      ...lookup,
      review: { offerId: lookup.offerId, text: "Review" },
    });
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(true);
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(await getHitlReviewResult(lookup)).toBe("review_required");
    expect(await consumeHitlRuling(lookup)).toBeUndefined();
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(
      false,
    );
    expect(
      await getHitlAskUserArguments({
        session: active,
        offerIds: [lookup.offerId],
      }),
    ).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("uses the staged review for fixed native approval choices", async () => {
  const active = session("active");
  await stageHitlReview({
    session: active,
    review: { offerId: "offer-1", text: "Canonical review text." },
  });

  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-1"],
    }),
  ).toEqual({
    question: "Canonical review text.",
    header: "Approval",
    options: [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ],
    allowMultiple: false,
    remedy_offer_ids: ["offer-1"],
  });
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "not-staged",
      ruling: "approve",
    }),
  ).toBe(false);
});

test("renders a terminal-safe heading without changing the reviewed payload", async () => {
  const active = session("terminal-review");
  const graphicHeading =
    "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?\n" +
    "\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   ";
  const reviewedArguments = JSON.stringify({ text: graphicHeading });
  const body = [
    'mcp/example/write {"text":"..."}',
    "",
    'APPA asks you to rule as the authority "reviewer".',
    "",
    "Tool: mcp/example/write",
    `Arguments:\n${reviewedArguments}`,
    "",
    "What this ruling would cover:\n  - attention: signoff",
    "",
    "Cancel answers nothing and leaves the call blocked.",
  ].join("\n");
  const review = {
    offerId: "offer-1",
    text: `${graphicHeading}${body}`,
    tool: "mcp/example/write",
    arguments: reviewedArguments,
    remedyArguments: { offer_id: "offer-1", plan: "Submit for approval" },
  };
  await stageHitlReview({ session: active, review });

  const staged = await getHitlReview({
    session: active,
    offerId: "offer-1",
  });
  expect(staged).toEqual(review);
  const nativeQuestion = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  expect(nativeQuestion?.question).toBe(
    `[OpenAPPA] Approve this call?\n${body}`,
  );
  expect(review.text).toBe(`${graphicHeading}${body}`);
});

test("a denial wins when concurrent reviews record different rulings", async () => {
  const active = session("concurrent");
  await stageHitlReview({
    session: active,
    review: { offerId: "offer-1", text: "Review this call." },
  });
  await Promise.all([
    recordHitlRuling({
      session: active,
      offerId: "offer-1",
      ruling: "approve",
    }),
    recordHitlRuling({
      session: active,
      offerId: "offer-1",
      ruling: "deny",
    }),
  ]);

  expect(
    await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-1"],
    }),
  ).toBeUndefined();
  expect(await consumeHitlRuling({ session: active, offerId: "offer-1" })).toBe(
    "deny",
  );
});

test("native reviewers atomically claim one approval and a timeout cannot overwrite it", async () => {
  const active = session("one-native-claim");
  await stageHitlReview({
    session: active,
    review: { offerId: "native-claim", text: "Review this exact call." },
  });
  const recorded = await Promise.all(
    Array.from({ length: 8 }, () =>
      recordHitlRuling({
        session: active,
        offerId: "native-claim",
        ruling: "approve",
      }),
    ),
  );
  expect(recorded.filter(Boolean)).toHaveLength(1);
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "native-claim",
      ruling: "none",
    }),
  ).toBe(false);
  expect(
    await consumeHitlRuling({ session: active, offerId: "native-claim" }),
  ).toBe("approve");
  expect(
    await consumeHitlRuling({ session: active, offerId: "native-claim" }),
  ).toBeUndefined();
});

test("a later genuine denial revokes an approval that has not been spent", async () => {
  const active = session("later-denial");
  await stageHitlReview({
    session: active,
    review: { offerId: "revoked", text: "Review this exact call." },
  });
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "revoked",
      ruling: "approve",
    }),
  ).toBe(true);
  expect(
    await recordHitlRuling({
      session: active,
      offerId: "revoked",
      ruling: "deny",
    }),
  ).toBe(true);
  expect(await consumeHitlRuling({ session: active, offerId: "revoked" })).toBe(
    "deny",
  );
  expect(
    await consumeHitlRuling({ session: active, offerId: "revoked" }),
  ).toBeUndefined();
});

test("approved native review context remains readable without reopening its claim", async () => {
  const active = session("native-continuation");
  const review = {
    offerId: "continuation",
    text: "The exact reviewed QA action",
    tool: "mcp/example/write",
    arguments: '{"value":1}',
  };
  await stageHitlReview({ session: active, review });
  expect(
    await recordHitlRuling({
      session: active,
      offerId: review.offerId,
      ruling: "approve",
    }),
  ).toBe(true);
  expect(
    await getHitlReview({ session: active, offerId: review.offerId }),
  ).toEqual(review);
  expect(
    await recordHitlRuling({
      session: active,
      offerId: review.offerId,
      ruling: "approve",
    }),
  ).toBe(false);
  expect(
    await consumeHitlRuling({ session: active, offerId: review.offerId }),
  ).toBe("approve");
  expect(
    await getHitlReview({ session: active, offerId: review.offerId }),
  ).toBeUndefined();
});
