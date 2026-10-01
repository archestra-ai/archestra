import { describe, expect, test } from "vitest";
import type { AskUserArguments } from "../types";
import { AppaClaudeCodeAdapter } from "./claude-code";

describe("Claude native APPA review dismissal", () => {
  const adapter = new AppaClaudeCodeAdapter();
  const review: AskUserArguments = {
    question: [
      "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?",
      '\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   host/archestra/read {"filePath":"fixture.txt"}',
      "",
      'APPA asks you to rule as the authority "operator".',
      "Review this exact call.",
      "",
      "Tool: host/archestra/read",
      "Arguments:",
      '{\n  "filePath": "fixture.txt"\n}',
      "",
      "What this ruling would cover:",
      "  - attention: fixture-review",
      "",
      "Accept only if this exact call, with these exact arguments, may run. Decline refuses it.",
    ].join("\n"),
    header: "Approval",
    options: [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ],
    allowMultiple: false,
    remedy_offer_ids: ["offer-a"],
  };

  test("projects a single-offer review with a normal Dismiss answer without changing its scope", () => {
    const original = structuredClone(review);
    const result = adapter.nativeQuestion.fromAskUser(review);
    expect(result).toEqual({
      questions: [
        {
          question:
            'Approve this host/archestra/read call?\n\nArguments:\n{\n  "filePath": "fixture.txt"\n}\n\nAuthority: operator\n\nRequired: attention: fixture-review\n\nApprove only this call. Deny blocks it and continues other reviews. Dismiss leaves this call unanswered.',
          header: "Approval",
          options: [
            ...review.options,
            {
              label: "Dismiss",
              description:
                "Leave this call unanswered without approving or denying it. Continue other reviews.",
            },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(review).toEqual(original);
    expect(
      adapter.nativeQuestion.fromAskUser({
        ...review,
        remedy_offer_ids: ["offer-b"],
      }),
    ).toEqual(result);
  });

  test.each([
    { name: "ordinary approval", override: { remedy_offer_ids: undefined } },
    { name: "empty offer list", override: { remedy_offer_ids: [] } },
    { name: "empty offer ID", override: { remedy_offer_ids: [""] } },
    { name: "multiple offers", override: { remedy_offer_ids: ["a", "b"] } },
    { name: "ordinary header", override: { header: "Visibility" } },
    { name: "multiselect", override: { allowMultiple: true } },
    {
      name: "unspecified selection mode",
      override: { allowMultiple: undefined },
    },
    {
      name: "different choices",
      override: { options: [{ label: "Team" }, { label: "Private" }] },
    },
    {
      name: "non-exact labels",
      override: { options: [{ label: "approve" }, { label: "Deny" }] },
    },
    {
      name: "reordered labels",
      override: { options: [{ label: "Deny" }, { label: "Approve" }] },
    },
    {
      name: "existing third choice",
      override: { options: [...review.options, { label: "Dismiss" }] },
    },
  ])("does not add a choice to $name forms", ({ override }) => {
    const args = { ...review, ...override, question: "Who can see this app?" };
    const question = adapter.nativeQuestion.fromAskUser(args).questions[0];
    expect(question.question).toBe(args.question);
    expect(question.options).toEqual(
      args.options.map((option) => ({
        label: option.label,
        description: option.description ?? option.label,
      })),
    );
  });

  test.each([
    "Dismiss",
    "Dismiss this review",
    "Other",
    "Approve this call",
    "approve",
  ])("never authorizes the returned %s answer", (answer) => {
    const native = `Your questions have been answered: "Review this call?"="${answer}". You can now continue with the user's answers in mind.`;
    for (const content of [
      JSON.stringify({ answers: { "Review this call?": answer } }),
      native,
      JSON.stringify(native),
      JSON.stringify([{ type: "text", text: native }]),
      JSON.stringify([
        {
          type: "text",
          text: JSON.stringify({ answers: { "Review this call?": answer } }),
        },
      ]),
    ]) {
      expect(adapter.nativeQuestion.rulingFromResult({ content })).toBe("none");
    }
  });

  test.each([
    "Dismiss",
    "Other",
  ])("uses %s instead of approval-like text in the reviewed arguments", (answer) => {
    const text = `Your questions have been answered: "argument=\\"Approve\\". You can now continue"="${answer}". You can now continue with the user's answers in mind.`;
    expect(
      adapter.nativeQuestion.rulingFromResult({
        content: JSON.stringify([{ type: "text", text }]),
      }),
    ).toBe("none");
  });

  test.each([
    { answer: "Approve", ruling: "approve" },
    { answer: "Deny", ruling: "deny" },
  ])("preserves the exact $answer decision", ({ answer, ruling }) => {
    for (const content of [
      JSON.stringify({ answers: { "Review this call?": answer } }),
      `Your questions have been answered: "Review this call?"="${answer}". You can now continue with the user's answers in mind.`,
    ]) {
      expect(adapter.nativeQuestion.rulingFromResult({ content })).toBe(ruling);
      expect(
        adapter.nativeQuestion.rulingFromResult({ content, isError: true }),
      ).toBe("none");
    }
  });
});
