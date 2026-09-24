import { describe, expect, test } from "@/test";
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
      content:
        '<task id="child" state="completed">\n<task_result>done</task_result>\n</task>',
    }),
  ).toBe(true);
});
