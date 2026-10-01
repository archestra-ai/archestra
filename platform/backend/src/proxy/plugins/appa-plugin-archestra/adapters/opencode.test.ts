import { describe, expect, test } from "vitest";
import { AppaOpenCodeAdapter } from "./opencode";

describe("OpenCode question from ask_user", () => {
  const askUser = {
    question: "Who can see this app?",
    options: [{ label: "Team" }, { label: "Organization" }],
  };

  test.each([
    { header: "Visibility", expected: "Visibility" },
    { header: "  Visibility  ", expected: "Visibility" },
    // Model arguments reach the proxy unvalidated: anything that is not a
    // usable label falls back to the generic one.
    { header: undefined, expected: "Question" },
    { header: "   ", expected: "Question" },
    { header: 42, expected: "Question" },
    // OpenCode's tab label holds 30 characters.
    {
      header: "Who should be able to see this app",
      expected: "Who should be able to see this",
    },
  ])("labels the question's tab $expected for header $header", ({
    header,
    expected,
  }) => {
    const question = new AppaOpenCodeAdapter().nativeQuestion.fromAskUser({
      ...askUser,
      header,
    });

    expect(question.questions[0].header).toBe(expected);
  });

  test("shows a plain native review question instead of the pixel-art prefix", () => {
    const review =
      '\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?\n\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   host/archestra/read {"filePath":"fixture.txt"}\n\nAPPA asks you to rule.';
    const result = new AppaOpenCodeAdapter().nativeQuestion.fromAskUser({
      ...askUser,
      question: review,
    });
    expect(result.questions[0].question).toBe(
      'Approve this call?\nhost/archestra/read {"filePath":"fixture.txt"}\n\nAPPA asks you to rule.',
    );
    expect(
      new AppaOpenCodeAdapter().nativeQuestion.fromAskUser(askUser).questions[0]
        .question,
    ).toBe(askUser.question);
  });

  test("shows the exact reviewed arguments once in OpenCode's native form", () => {
    const review = [
      "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?",
      '\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   host/archestra/read {"filePath":"fixture.txt"}',
      "",
      'APPA asks you to rule as the authority "operator".',
      "A test-only review for the harmless read call.",
      "",
      "Tool: host/archestra/read",
      "Arguments:",
      '{\n  "filePath": "fixture.txt"\n}',
      "",
      "What this ruling would cover:",
      "  - attention: shell-remedy-lab-review",
      "",
      "Accept only if this exact call, with these exact arguments, may run. Decline refuses it.",
    ].join("\n");
    const question = new AppaOpenCodeAdapter().nativeQuestion.fromAskUser({
      ...askUser,
      question: review,
    }).questions[0].question;
    expect(question).toBe(
      'Approve this host/archestra/read call?\n\nArguments:\n{\n  "filePath": "fixture.txt"\n}\n\nAuthority: operator\n\nRequired: attention: shell-remedy-lab-review\n\nApprove only this call. Deny blocks it and continues other reviews. Cancel leaves this call unanswered.',
    );
    expect(question.match(/fixture.txt/g)).toHaveLength(1);
  });
});

test("a background task launch is not a child completion", () => {
  const adapter = new AppaOpenCodeAdapter();
  const result = {
    id: "spawn-call",
    name: "task",
    isError: false,
    content:
      '<task id="child" state="running">\n<summary>Background task started</summary>\n</task>',
  };

  expect(adapter.isChildCompletionResult(result)).toBe(false);
  expect(
    adapter.isChildCompletionResult({
      ...result,
      content: "<task state = 'pending' id='child'>queued</task>",
    }),
  ).toBe(false);
  expect(
    adapter.isChildCompletionResult({
      ...result,
      content:
        '<task id="child" state="completed">\n<task_result>done</task_result>\n</task>',
    }),
  ).toBe(true);
});
