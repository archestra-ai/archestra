import { describe, expect, test } from "vitest";
import { AppaKiloAdapter, AppaOpenCodeAdapter } from "./opencode";

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

describe("Kilo Code adapter", () => {
  const kilo = new AppaKiloAdapter();
  const kiloUserAgent =
    "kilo/latest/7.8.8/cli ai-sdk/provider-utils/4.0.46 runtime/bun/1.4.2";

  const match = (headers: Record<string, string>) =>
    kilo.matches({ headers, requestBody: {} });

  test("matches Kilo, and only Kilo, so OpenCode keeps its own adapter", () => {
    expect(match({ "user-agent": kiloUserAgent })).toBe(true);
    expect(match({ "X-Archestra-Agent-Id": "kilo" })).toBe(true);
    expect(match({ "user-agent": "opencode/1.18.29" })).toBe(false);
    // Kilo's ChatGPT login stamps OpenCode's identity; OpenCode handles it.
    expect(match({ originator: "opencode" })).toBe(false);
    expect(match({ "x-session-affinity": "ses_untrusted" })).toBe(false);
  });

  test("reads Kilo's question answer and task results as OpenCode's", () => {
    // The answer text kilo 7.8.8's question tool returns.
    const answer = {
      id: "q",
      name: "question",
      isError: false,
      content:
        'User has answered your questions: "Run the migration?"="Approve". You can now continue with the user\'s answers in mind.',
    };
    expect(
      kilo.nativeQuestion.rulingFromResult(answer, {
        question: "Run the migration?",
        options: [{ label: "Approve" }, { label: "Deny" }],
      }),
    ).toBe("approve");
    expect(kilo.isSpawnTool("task")).toBe(true);
    expect(
      kilo.isChildCompletionResult({
        id: "spawn-call",
        name: "task",
        isError: false,
        content:
          '<task id="ses_child" state="completed">\n<task_result>done</task_result>\n</task>',
      }),
    ).toBe(true);
  });
});
