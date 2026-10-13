import { expect, test, vi } from "vitest";
import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlReview,
  getHitlReviewResult,
  peekHitlDecision,
  peekHitlRuling,
  recordHitlReviewResult,
  recordHitlRuling,
  reviewOutcomeFromClosure,
  reviewSessionFromTrajectory,
  sealHitlClosure,
  stageHitlReview,
} from "./hitl-review";
import type { OpenAppaSession } from "./service";

vi.mock("@/logging");

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

test("warns when no review caller can be recovered, and only then", () => {
  vi.mocked(logger.warn).mockClear();
  reviewSessionFromTrajectory({
    organizationId: "organization",
    trajectory: { session_id: "foreign-root" },
    context: { userId: "chat-user", conversationId: "chat-root" },
  });
  expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: "organization",
      sessionId: "foreign-root",
    }),
    expect.stringContaining("no resolvable caller"),
  );

  vi.mocked(logger.warn).mockClear();
  reviewSessionFromTrajectory({
    organizationId: "organization",
    trajectory: { session_id: "chat-root" },
    context: { userId: "chat-user", conversationId: "chat-root" },
  });
  expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
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
  "review_declined",
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

test("asks preview hosts about a structured tool by name and previews its arguments beside each choice", async () => {
  const active = session("preview-review");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: "Full review text.",
      tool: "mcp/slack/send_message",
      arguments: JSON.stringify({ channel: "#general", text: "Hello" }),
    },
  });

  const argumentLines = "channel  #general\ntext     Hello";
  expect(
    await getHitlAskUserArguments({ session: active, offerIds: ["offer-1"] }),
  ).toEqual({
    question: "Full review text.",
    previewQuestion: "Approve slack__send_message?",
    header: "Approval",
    options: [
      {
        label: "Approve",
        description: "Allow this exact tool call.",
        preview: `Approve\n\n${argumentLines}`,
      },
      {
        label: "Deny",
        description: "Keep this tool call blocked.",
        preview: `Deny\n\n${argumentLines}`,
      },
    ],
    allowMultiple: false,
    remedy_offer_ids: ["offer-1"],
  });
});

test("wraps long argument values to the preview pane width", async () => {
  const active = session("wrapped-preview");
  const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: "Full review text.",
      tool: "mcp/slack/send_message",
      arguments: JSON.stringify({ text }),
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  const lines = question?.options[0].preview?.split("\n") ?? [];
  expect(lines.slice(0, 2)).toEqual(["Approve", ""]);
  expect(lines.length).toBeGreaterThan(3);
  expect(lines.slice(2).every((line) => line.length <= 56)).toBe(true);
  expect(
    lines
      .slice(2)
      .map((line) => line.slice("text  ".length))
      .join(" "),
  ).toBe(text);
});

test.each([
  ["no arguments", undefined],
  ["empty arguments", "{}"],
  ["arguments that are not an object", "[1,2]"],
])("previews only the choice when the review has %s", async (_, reviewedArguments) => {
  const active = session("bare-preview");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: "Full review text.",
      tool: "local_tool",
      ...(reviewedArguments ? { arguments: reviewedArguments } : {}),
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  expect(question?.question).toBe("Full review text.");
  expect(question?.previewQuestion).toBe("Approve local_tool?");
  expect(question?.options.map((option) => option.preview)).toEqual([
    "Approve",
    "Deny",
  ]);
});

/** A review as the OpenAPPA runtime writes it, with the given coverage lines. */
function runtimeReview(coverage: string): string {
  return [
    "[OpenAPPA] Approve this call?",
    'APPA asks you to rule as the authority "hitl".',
    "Ask the person running this session to approve this exact call.",
    "",
    "Tool: host/archestra/send_report",
    "Arguments:",
    '{\n  "to": "finance@example.com"\n}',
    "",
    "What this ruling would cover:",
    coverage,
    "",
    "Accept only if this exact call, with these exact arguments, may run. Decline refuses it.",
  ].join("\n");
}

test.each([
  {
    case: "the person's attention only",
    coverage: "  - attention: human-approval",
    expected:
      "Approve send_report?\n\nto  finance@example.com\n\nApprove lets this exact call run. Deny keeps it blocked.",
    expectedPreview: "Approve send_report?",
  },
  {
    case: "more than the person's attention",
    coverage:
      "  - attention: human-approval\n  - the readers must be the public audience",
    expected:
      "Approve send_report?\n\nto  finance@example.com\n\nApproving also accepts:\n  - the readers must be the public audience\n\nApprove lets this exact call run. Deny keeps it blocked.",
    expectedPreview:
      "Approve send_report?\n\nApproving also accepts:\n  - the readers must be the public audience",
  },
])("asks about the call itself when the ruling covers $case", async ({
  coverage,
  expected,
  expectedPreview,
}) => {
  const active = session("form-question");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: runtimeReview(coverage),
      tool: "send_report",
      arguments: '{"to":"finance@example.com"}',
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  expect(question?.question).toBe(expected);
  expect(question?.previewQuestion).toBe(expectedPreview);
});

test("shows a command once although the proxy reviews it under both spellings", async () => {
  const active = session("command-review");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: runtimeReview("  - the readers must be the public audience"),
      tool: "Bash",
      // The runtime returns the arguments as the proxy evaluated them.
      arguments: JSON.stringify({
        cmd: "git push -u origin feature",
        command: "git push -u origin feature",
        description: "Push the branch",
      }),
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  const argumentLines =
    "command      git push -u origin feature\ndescription  Push the branch";
  expect(question?.options[0].preview).toBe(`Approve\n\n${argumentLines}`);
  expect(question?.question).toBe(
    `Approve Bash?\n\n${argumentLines}\n\nApproving also accepts:\n  - the readers must be the public audience\n\nApprove lets this exact call run. Deny keeps it blocked.`,
  );
});

test("keeps both arguments when a command tool's cmd and command differ", async () => {
  const active = session("distinct-command-review");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: "Full review text.",
      tool: "exec_command",
      arguments: JSON.stringify({ cmd: "ls", command: "rm -rf build" }),
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  expect(question?.options[0].preview).toBe(
    "Approve\n\ncmd      ls\ncommand  rm -rf build",
  );
});

test("keeps the full review text when its coverage is in an unknown shape", async () => {
  const active = session("unknown-coverage");
  const text = runtimeReview("  * the readers must be the public audience");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text,
      tool: "send_report",
      arguments: '{"to":"finance@example.com"}',
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  expect(question?.question).toBe(text);
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

test("a closure cannot erase an unspent approval, and a later denial still can", async () => {
  const active = session("closure-cannot-revoke");
  const lookup = { session: active, offerId: "kept" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "kept", text: "Review this exact call." },
  });
  expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(true);
  expect(
    await recordHitlRuling({ ...lookup, ruling: "none", closure: "cancelled" }),
  ).toBe(false);
  expect(await sealHitlClosure({ ...lookup, closure: "unavailable" })).toBe(
    "approve",
  );
  expect(await peekHitlRuling(lookup)).toBe("approve");
  expect(await recordHitlRuling({ ...lookup, ruling: "deny" })).toBe(true);
  expect(await consumeHitlRuling(lookup)).toBe("deny");
});

test("an approval wins when it races a closure", async () => {
  const active = session("closure-race");
  const lookup = { session: active, offerId: "race" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "race", text: "Review this exact call." },
  });
  await Promise.all([
    recordHitlRuling({ ...lookup, ruling: "approve" }),
    sealHitlClosure({ ...lookup, closure: "cancelled" }),
  ]);
  expect(await consumeHitlRuling(lookup)).toBe("approve");
  expect(await peekHitlDecision(lookup)).toBeUndefined();
});

test("a later stage does not reopen a sealed closure", async () => {
  const lookup = { session: session("stage-after-seal"), offerId: "closed" };
  const review = { offerId: "closed", text: "Review this exact call." };
  await stageHitlReview({ ...lookup, review });
  expect(await sealHitlClosure({ ...lookup, closure: "unavailable" })).toBe(
    "sealed",
  );
  expect(await stageHitlReview({ ...lookup, review })).toEqual({
    status: "none",
    closure: "unavailable",
  });
  expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(false);
  expect(await peekHitlDecision(lookup)).toEqual({
    ruling: "none",
    closure: "unavailable",
  });
  expect(await getHitlReview(lookup)).toBeUndefined();
});

test("an existing denial is not replaced by a ghost review", async () => {
  const lookup = { session: session("stage-after-deny"), offerId: "denied" };
  const review = { offerId: "denied", text: "Review this exact call." };
  await stageHitlReview({ ...lookup, review });
  expect(await recordHitlRuling({ ...lookup, ruling: "deny" })).toBe(true);
  expect(await stageHitlReview({ ...lookup, review })).toEqual({
    status: "deny",
  });
  expect(
    await getHitlAskUserArguments({
      session: lookup.session,
      offerIds: [lookup.offerId],
    }),
  ).toBeUndefined();
  expect(await peekHitlRuling(lookup)).toBe("deny");
  expect(await getHitlReview(lookup)).toBeUndefined();
});

test("a sealed closure stays closed and is not a denial", async () => {
  const lookup = { session: session("sealed-closure"), offerId: "closed" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "closed", text: "Review this exact call." },
  });
  expect(await sealHitlClosure({ ...lookup, closure: "declined" })).toBe(
    "sealed",
  );
  expect(await peekHitlDecision(lookup)).toEqual({
    ruling: "none",
    closure: "declined",
  });
  expect(reviewOutcomeFromClosure("declined")).toBe("review_declined");
  expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(false);
  expect(await recordHitlRuling({ ...lookup, ruling: "deny" })).toBe(false);
  expect(await consumeHitlRuling(lookup)).toBe("none");
  expect(await peekHitlDecision(lookup)).toEqual({
    ruling: "none",
    closure: "declined",
  });
});

test("a stored none without a closure is not a denial", async () => {
  const lookup = { session: session("legacy-none"), offerId: "legacy" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "legacy", text: "Review this exact call." },
  });
  expect(await recordHitlRuling({ ...lookup, ruling: "none" })).toBe(true);
  expect(await peekHitlDecision(lookup)).toEqual({ ruling: "none" });
  expect(reviewOutcomeFromClosure(undefined)).toBe("review_invalid");
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

test("a denial validated before consumption cannot write an orphan ruling afterward", async () => {
  const lookup = { session: session("denial-before-consume"), offerId: "race" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "race", text: "Review" },
  });
  expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(true);
  const read = barrier();
  const resume = barrier();
  const consuming = barrier();
  let calls = 0;
  interceptLockedCache(
    (cache) => {
      const get = cache.get;
      cache.get = async <T>(key: AllowedCacheKey) => {
        const value = await get<T>(key);
        read.release();
        await resume.wait;
        return value;
      };
    },
    () => {
      if (++calls === 2) consuming.release();
    },
  );
  const denial = recordHitlRuling({ ...lookup, ruling: "deny" });
  await read.wait;
  const consumption = consumeHitlRuling(lookup);
  await consuming.wait;
  resume.release();
  expect(await denial).toBe(true);
  expect(await consumption).toBe("deny");
  expect(await peekHitlRuling(lookup)).toBeUndefined();
  expect(await consumeHitlRuling(lookup)).toBeUndefined();
});

test("a denial starting during consumption cleanup cannot leave an orphan ruling", async () => {
  const lookup = { session: session("denial-during-cleanup"), offerId: "race" };
  await stageHitlReview({
    ...lookup,
    review: { offerId: "race", text: "Review" },
  });
  expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(true);
  const taken = barrier();
  const resume = barrier();
  const denying = barrier();
  let calls = 0;
  interceptLockedCache(
    (cache) => {
      const take = cache.getAndDeleteMany;
      cache.getAndDeleteMany = async <T>(keys: AllowedCacheKey[]) => {
        const entries = await take<T>(keys);
        taken.release();
        await resume.wait;
        return entries;
      };
    },
    () => {
      if (++calls === 2) denying.release();
    },
  );
  const consumption = consumeHitlRuling(lookup);
  await taken.wait;
  const denial = recordHitlRuling({ ...lookup, ruling: "deny" });
  await denying.wait;
  resume.release();
  expect(await consumption).toBe("approve");
  expect(await denial).toBe(false);
  expect(await peekHitlRuling(lookup)).toBeUndefined();
  expect(await consumeHitlRuling(lookup)).toBeUndefined();
});

test("rulings cannot claim another organization, caller, parent, or expired stage", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const active = { ...session("scoped-stage"), parent_id: "parent" };
    const lookup = { session: active, offerId: "race" };
    await stageHitlReview({
      ...lookup,
      review: { offerId: "race", text: "Review" },
    });
    for (const other of [
      { ...active, organization_id: "other" },
      { ...active, caller_id: "user:other" },
      { ...active, parent_id: "other" },
      { ...active, session_id: "other" },
    ]) {
      expect(
        await recordHitlRuling({
          session: other,
          offerId: "race",
          ruling: "deny",
        }),
      ).toBe(false);
      expect(
        await consumeHitlRuling({ session: other, offerId: "race" }),
      ).toBeUndefined();
    }
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    for (const ruling of ["approve", "deny", "none"] as const)
      expect(await recordHitlRuling({ ...lookup, ruling })).toBe(false);
    expect(await peekHitlRuling(lookup)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("a recorded ruling keeps its own ten-minute TTL without reviving the expired stage", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const lookup = {
      session: session("ruling-ttl"),
      offerId: "race",
      callId: "control",
    };
    await stageHitlReview({
      ...lookup,
      review: { offerId: "race", text: "Review" },
    });
    vi.setSystemTime(Date.now() + 9 * 60 * 1000);
    expect(await recordHitlRuling({ ...lookup, ruling: "approve" })).toBe(true);
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    expect(await getHitlReview(lookup)).toBeUndefined();
    expect(await recordHitlRuling({ ...lookup, ruling: "deny" })).toBe(false);
    expect(await consumeHitlRuling(lookup)).toBe("approve");
    expect(await consumeHitlRuling(lookup)).toBeUndefined();
    expect(await getHitlReviewResult(lookup)).toBe("review_required");
  } finally {
    vi.useRealTimers();
  }
});

type LockedCache = Parameters<Parameters<typeof cacheManager.withLock>[1]>[0];

function interceptLockedCache(
  intercept: (cache: LockedCache) => void,
  entered: () => void,
) {
  const lock = cacheManager.withLock.bind(cacheManager);
  vi.spyOn(cacheManager, "withLock").mockImplementation(
    <T>(
      scope: AllowedCacheKey,
      callback: (cache: LockedCache) => Promise<T>,
    ) => {
      entered();
      return lock(scope, async (cache) => {
        intercept(cache);
        return callback(cache);
      });
    },
  );
}

function barrier() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
