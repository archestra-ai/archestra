// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test, vi } from "vitest";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  consumeHitlRuling,
  getHitlInspectableAskUserArguments,
  peekHitlRuling,
  resolveHitlInspectableAnswer,
  sealHitlClosure,
  stageHitlReview,
} from "./hitl-review";
import {
  type HitlReviewCard,
  hitlInspectionDigest,
  hitlReviewOverviewCard,
  needsHitlReviewInspection,
  renderHitlReviewText,
  withInspectDetailsOption,
} from "./hitl-review-overview";
import type { OpenAppaSession } from "./service";

vi.mock("@/logging");
vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: vi
    .fn()
    .mockRejectedValue(new Error("summary service unavailable")),
}));

// The real cache, stored in this file's test database.
setupTestCacheManager();

const session = (sessionId: string): OpenAppaSession => ({
  organization_id: "organization",
  caller_id: "user:user",
  session_id: sessionId,
});

const COVERAGE = [
  "[OpenAPPA] Approve this call?",
  'APPA asks you to rule as the authority "hitl".',
  "",
  "What this ruling would cover:",
  "  - the readers must be the public audience",
  "",
].join("\n");

function longReview(offerId: string, command?: string) {
  const cmd = command ?? `echo ${"exact-payload ".repeat(400)}`;
  return {
    offerId,
    text: COVERAGE,
    tool: "Bash",
    arguments: JSON.stringify({ command: cmd, cmd }),
    remedyArguments: { offer_id: offerId, plan: "Submit for approval" },
  };
}

function smallReview(offerId: string) {
  return {
    offerId,
    text: COVERAGE,
    tool: "Bash",
    arguments: JSON.stringify({ command: "ls -la", cmd: "ls -la" }),
    remedyArguments: { offer_id: offerId, plan: "Submit for approval" },
  };
}

describe("needsHitlReviewInspection", () => {
  const base: HitlReviewCard = {
    question: "Approve the Bash command?",
    shortQuestion: "Approve the Bash command?",
    callPreview: "```sh\nls -la\n```",
    header: "Approval",
    options: [{ label: "Approve", description: "Allow." }],
    allowMultiple: false,
    remedy_offer_ids: ["offer"],
  };

  test("a card that shows its call in full needs no inspection overview", () => {
    expect(needsHitlReviewInspection(base)).toBe(false);
  });

  test("a withheld or oversized preview needs the overview", () => {
    expect(
      needsHitlReviewInspection({
        ...base,
        callPreview: `x${"y".repeat(2000)}`,
        question: `Approve?\n${"detail\n".repeat(400)}`,
      }),
    ).toBe(true);
    expect(
      needsHitlReviewInspection({
        ...base,
        callPreview: "withheld …",
        question: "q",
      }),
    ).toBe(true);
    expect(
      needsHitlReviewInspection({
        ...base,
        callPreview: undefined,
        shortQuestion: undefined,
        question: `Approve?\n${"detail\n".repeat(400)}`,
      }),
    ).toBe(true);
  });

  test("a multi-select card is never inspected this way", () => {
    expect(
      needsHitlReviewInspection({
        ...base,
        allowMultiple: true as never,
        question: `Approve?\n${"detail\n".repeat(400)}`,
      }),
    ).toBe(false);
  });
});

describe("hitlReviewOverviewCard", () => {
  const base: HitlReviewCard = {
    question: "Approve the Bash command?",
    shortQuestion: "Approve the Bash command?",
    callPreview: "withheld",
    header: "Approval",
    options: [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ],
    allowMultiple: false,
    remedy_offer_ids: ["offer"],
  };

  test("is compact, literal, and free of markdown markers", () => {
    const command = `echo ${"exact-payload ".repeat(400)}`;
    const { card, approve } = hitlReviewOverviewCard({
      base,
      review: {
        tool: "Bash",
        arguments: JSON.stringify({ command, cmd: command }),
        text: COVERAGE,
      },
    });
    expect(approve).toBe(true);
    expect(card.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
      "Inspect details",
    ]);
    const preview = card.callPreview ?? "";
    expect(preview.length).toBeLessThanOrEqual(2000);
    expect(preview.startsWith("```")).toBe(true);
    expect(preview.endsWith("```")).toBe(true);
    // Plaintext labels: no emphasis markers, no escaped markdown.
    expect(preview).not.toContain("**");
    expect(preview).not.toContain("\\_");
    expect(preview).not.toContain("\\(");
    expect(preview).toContain("Policy scope:");
    expect(preview.replace(/\s+/g, " ")).toContain(
      "- the readers must be the public audience",
    );
    expect(preview).toContain("Approval review\nBash");
    // The long command itself is left to Inspect details, not truncated here.
    expect(preview).not.toContain(command.slice(0, 100));
    expect(preview).toContain("Inspect details");
    expect(card.question.length).toBeLessThan(200);
    expect(card.shortQuestion).toBe(card.question);
    expect(card.remedy_offer_ids).toEqual(["offer"]);
  });

  test("shows a short command literally and never alters genuine backslashes", () => {
    const command = String.raw`printf 'a\_b \(c\) **d**' && echo "done"`;
    const { card, approve } = hitlReviewOverviewCard({
      base,
      review: {
        tool: "Bash",
        arguments: JSON.stringify({ command, cmd: command }),
        text: COVERAGE,
      },
    });
    expect(approve).toBe(true);
    expect(card.callPreview).toContain(command);
  });

  test("omits Approve when the authoritative policy scope cannot fit", () => {
    const wide = `  - ${"condition ".repeat(200)}`;
    const { card, approve } = hitlReviewOverviewCard({
      base,
      review: {
        tool: "Bash",
        arguments: JSON.stringify({ command: "ls", cmd: "ls" }),
        text: [
          "[OpenAPPA] Approve this call?",
          "",
          "What this ruling would cover:",
          wide,
          wide,
          wide,
          wide,
          wide,
          "",
        ].join("\n"),
      },
    });
    expect(approve).toBe(false);
    expect(card.options.map((option) => option.label)).toEqual([
      "Deny",
      "Inspect details",
    ]);
    expect(card.callPreview).toContain("does not fit this card");
    // The scope itself is not shortened into the card.
    expect(card.callPreview).not.toContain("condition condition");
    expect((card.callPreview ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("shows an unknown scope shape in full when it fits, with Approve", () => {
    const text = [
      "What this ruling would cover:",
      "  - the readers must be the public audience",
      "BUT only on a Tuesday",
      "",
    ].join("\n");
    const { card, approve } = hitlReviewOverviewCard({
      base,
      review: { tool: "Bash", arguments: "{}", text },
    });
    // Nothing of the unknown shape is dropped or paraphrased.
    expect(approve).toBe(true);
    expect(card.callPreview).toContain("BUT only on a Tuesday");
    expect(card.callPreview).toContain("Policy review:");
  });

  test("omits Approve when an unknown scope shape does not fit", () => {
    const text = [
      "What this ruling would cover:",
      "  - the readers must be the public audience",
      `BUT only when ${"condition ".repeat(300)}`,
      "",
    ].join("\n");
    const { card, approve } = hitlReviewOverviewCard({
      base,
      review: { tool: "Bash", arguments: "{}", text },
    });
    expect(approve).toBe(false);
    expect(card.options.map((option) => option.label)).toEqual([
      "Deny",
      "Inspect details",
    ]);
    // The full text survives in the complete review text instead.
    const full = renderHitlReviewText({ tool: "Bash", arguments: "{}", text });
    expect(full).toContain("BUT only when");
  });
});

describe("renderHitlReviewText", () => {
  test("renders the complete review: paragraphs, literal commands, formatted JSON", () => {
    const command = `echo ${"exact-payload ".repeat(800)}`;
    const text = renderHitlReviewText({
      tool: "mcp/filesystem__write_file",
      arguments: JSON.stringify({
        command,
        cmd: command,
        message: "Dear reviewer,\n\nthis is prose.",
        options: { recursive: true, depth: 3 },
      }),
      text: COVERAGE,
      summary: "Runs a long echo.",
    });
    expect(text).toContain("## Approval review");
    expect(text).toContain("### Tool\n\nmcp/filesystem\\_\\_write\\_file");
    // Policy coverage verbatim as bullets; the runtime's copy of the
    // arguments is not duplicated inside the policy section.
    expect(text).toContain("### Policy review (authoritative)");
    expect(text).toContain("- the readers must be the public audience");
    expect(text).toContain('rule as the authority "hitl"');
    expect(text).not.toContain("What this ruling would cover:");
    // The exact command is literal; the identical normalized alias is identified.
    expect(text).toContain(command);
    expect(text).toContain("```sh");
    // Prose as paragraphs, structured values as formatted JSON.
    expect(text).toContain("message:\n\nDear reviewer,\n\nthis is prose.");
    expect(text).toContain('"recursive": true');
    expect(text).toContain('"depth": 3');
    expect(text).toContain("### Generated summary (not authoritative)");
    expect(text).toContain("Runs a long echo.");
    expect(text).toContain("### Reading this review");
  });

  test("escapes invisible control characters without touching genuine backslashes", () => {
    const tricky = "path C:\\Temp\\note.txt has \u001b[31m color";
    const text = renderHitlReviewText({
      tool: "Bash",
      arguments: JSON.stringify({ command: tricky, cmd: tricky }),
      text: COVERAGE,
    });
    // The terminal escape is neutralized into a visible JSON escape, and the
    // genuine backslashes stay, doubled exactly as JSON encodes them.
    expect(text).not.toContain("\u001b");
    expect(text).toContain("C:\\\\Temp\\\\note.txt");
    expect(text).toContain("\\u001b");
    expect(text).toContain("escaped");
  });

  test("shows unparsed arguments verbatim", () => {
    const text = renderHitlReviewText({
      tool: "Bash",
      arguments: "{not json",
      text: COVERAGE,
    });
    expect(text).toContain("not valid JSON");
    expect(text).toContain("{not json");
  });
});

describe("withInspectDetailsOption", () => {
  test("appends Inspect without changing the existing options", () => {
    const card: HitlReviewCard = {
      question: "Approve?",
      header: "Approval",
      options: [
        { label: "Approve", description: "Allow this exact tool call." },
        { label: "Deny", description: "Keep this tool call blocked." },
      ],
      allowMultiple: false,
      remedy_offer_ids: ["offer"],
    };
    const inspected = withInspectDetailsOption(card);
    expect(inspected.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
      "Inspect details",
    ]);
    expect(inspected.options[0]).toEqual(card.options[0]);
    expect(inspected.question).toBe("Approve?");
  });
});

async function issuedDigest(
  reviewSession: OpenAppaSession,
  offerId: string,
): Promise<string> {
  const issued = await getHitlInspectableAskUserArguments({
    session: reviewSession,
    offerIds: [offerId],
    emit: false,
  });
  if (!issued) throw new Error("expected an inspectable card");
  return issued.digest;
}

describe("inspection state", () => {
  test("the overview emits no text until a signed Inspect answer", async () => {
    const offerId = "offer-inspect-quiet";
    const reviewSession = session("user:user|inspect-quiet");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const first = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(first?.reviewText).toBeUndefined();
    expect(first?.card.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
      "Inspect details",
    ]);
    // A compact overview replaced the withheld full preview.
    expect((first?.card.callPreview ?? "").length).toBeLessThanOrEqual(2000);
    expect(first?.card.callPreview).toContain("Policy scope:");
  });

  test("inspect pendings the review and the next issue carries the complete text", async () => {
    const offerId = "offer-inspect-emit";
    const reviewSession = session("user:user|inspect-emit");
    const command = `echo ${"exact-payload ".repeat(400)}`;
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId, command),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    const asked = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(asked).toEqual({ status: "inspect-pending" });
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    const next = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(next?.reviewText).toContain("## Approval review");
    expect(next?.reviewText).toContain(command);
    expect(next?.reviewText).toContain(
      "- the readers must be the public audience",
    );
    // The same compact card accompanies the text.
    expect(next?.card.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
      "Inspect details",
    ]);
  });

  test("an answer to a text-carrying card delivers the inspection; later asks emit no duplicate", async () => {
    const offerId = "offer-inspect-once";
    const reviewSession = session("user:user|inspect-once");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: digest,
    });
    const emitted = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(emitted?.reviewText).toBeDefined();
    // Inspecting again from the card that carried the text: delivered, and
    // the text is not emitted twice.
    const again = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: true,
      claimDigest: digest,
    });
    expect(again).toEqual({ status: "inspect-shown" });
    const repeated = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(repeated?.reviewText).toBeUndefined();
    expect(repeated?.card.options.map((option) => option.label)).toContain(
      "Inspect details",
    );
  });

  test("no approval while a requested inspection is undelivered", async () => {
    const offerId = "offer-inspect-gate";
    const reviewSession = session("user:user|inspect-gate");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: digest,
    });
    // An answer from a card issued before the inspection: no grant.
    const early = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(early).toEqual({ status: "stale" });
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    // The card issued with the text accepts the approval.
    const after = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: true,
      claimDigest: digest,
    });
    expect(after).toEqual({ status: "recorded", ruling: "approve" });
    await expect(
      consumeHitlRuling({ session: reviewSession, offerId }),
    ).resolves.toBe("approve");
  });

  test("an immediate overview approval without any inspection is allowed", async () => {
    const offerId = "offer-inspect-immediate";
    const reviewSession = session("user:user|inspect-immediate");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const approved = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: false,
      claimDigest: await issuedDigest(reviewSession, offerId),
    });
    expect(approved).toEqual({ status: "recorded", ruling: "approve" });
    await expect(
      consumeHitlRuling({ session: reviewSession, offerId }),
    ).resolves.toBe("approve");
  });

  test("a small review's card gains only the Inspect option and approves immediately", async () => {
    const offerId = "offer-inspect-small";
    const reviewSession = session("user:user|inspect-small");
    await stageHitlReview({
      session: reviewSession,
      review: smallReview(offerId),
    });
    const issued = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    // The ordinary preview card, not the overview.
    expect(issued?.card.shortQuestion).toBe("Approve the Bash command?");
    expect(issued?.card.callPreview).toContain("ls -la");
    expect(issued?.card.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
      "Inspect details",
    ]);
    expect(issued?.reviewText).toBeUndefined();
    const approved = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: false,
      claimDigest: await issuedDigest(reviewSession, offerId),
    });
    expect(approved).toEqual({ status: "recorded", ruling: "approve" });
  });

  test("deny records from any inspection state", async () => {
    const offerId = "offer-inspect-deny";
    const reviewSession = session("user:user|inspect-deny");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: digest,
    });
    const denied = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "deny",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(denied).toEqual({ status: "recorded", ruling: "deny" });
    await expect(
      consumeHitlRuling({ session: reviewSession, offerId }),
    ).resolves.toBe("deny");
  });

  test("a re-staged review resets the inspection of the old payload", async () => {
    const offerId = "offer-inspect-restage";
    const reviewSession = session("user:user|inspect-restage");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const oldDigest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: oldDigest,
    });
    // Re-stage with a different payload: the old inspection no longer applies.
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId, "echo changed-payload"),
    });
    const issued = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(issued?.reviewText).toBeUndefined();
    // A card of the old payload rules nothing after the re-stage: no
    // approval from it, not even a denial, and its text marker delivers
    // nothing for the new payload.
    const staleApprove = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: true,
      claimDigest: oldDigest,
    });
    expect(staleApprove).toEqual({ status: "stale" });
    const staleDeny = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "deny",
      carriedReviewText: false,
      claimDigest: oldDigest,
    });
    expect(staleDeny).toEqual({ status: "stale" });
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    // The new payload's own card can still inspect and approve.
    const newDigest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: newDigest,
    });
    const emitted = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(emitted?.reviewText).toContain("echo changed-payload");
    const approved = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: true,
      claimDigest: newDigest,
    });
    expect(approved).toEqual({ status: "recorded", ruling: "approve" });
  });

  test("an old card's text marker does not deliver a re-staged inspection", async () => {
    const offerId = "offer-inspect-oldmarker";
    const reviewSession = session("user:user|inspect-oldmarker");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const oldDigest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: oldDigest,
    });
    // The text went out with a card of this payload, then the payload was
    // re-staged and inspected again before any answer came back.
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId, "echo changed-payload"),
    });
    const newDigest = await issuedDigest(reviewSession, offerId);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: newDigest,
    });
    // The old card's answer arrives now: stale, and the new payload's
    // inspection is still pending — the next issue emits the text.
    const late = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: true,
      claimDigest: oldDigest,
    });
    expect(late).toEqual({ status: "stale" });
    const emitted = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(emitted?.reviewText).toBeDefined();
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
  });

  test("a ruled review offers no inspectable card", async () => {
    const offerId = "offer-inspect-closed";
    const reviewSession = session("user:user|inspect-closed");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    await sealHitlClosure({
      session: reviewSession,
      offerId,
      closure: "cancelled",
    });
    await expect(
      getHitlInspectableAskUserArguments({
        session: reviewSession,
        offerIds: [offerId],
      }),
    ).resolves.toBeUndefined();
    const late = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: true,
      claimDigest: "irrelevant-after-close",
    });
    expect(late).toEqual({ status: "closed" });
    // The closure stands; nothing was granted.
    await expect(
      consumeHitlRuling({ session: reviewSession, offerId }),
    ).resolves.toBe("none");
  });

  test("inspection state binds to the exact staged payload", async () => {
    const offerId = "offer-inspect-digest";
    const reviewSession = session("user:user|inspect-digest");
    const review = longReview(offerId);
    await stageHitlReview({ session: reviewSession, review });
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: await issuedDigest(reviewSession, offerId),
    });
    // A restage of the identical payload keeps the pending inspection.
    await stageHitlReview({ session: reviewSession, review });
    const issued = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(issued?.reviewText).toContain("## Approval review");
    expect(hitlInspectionDigest(review)).toBe(
      hitlInspectionDigest({ ...review }),
    );
  });
});
