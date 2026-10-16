import { load as loadYaml } from "js-yaml";
import { describe, expect, test, vi } from "vitest";
import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { AppaClaudeCodeAdapter } from "@/proxy/plugins/appa-plugin-archestra/adapters/claude-code";
import { AppaCodexAdapter } from "@/proxy/plugins/appa-plugin-archestra/adapters/codex";
import { AppaOpenCodeAdapter } from "@/proxy/plugins/appa-plugin-archestra/adapters/opencode";
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

/** Stages one review of `tool` with `args` and returns what Claude Code is asked. */
async function askedAbout(
  name: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const active = session(name);
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: "Full review text.",
      tool,
      arguments: JSON.stringify(args),
    },
  });
  return getHitlAskUserArguments({ session: active, offerIds: ["offer-1"] });
}

test("asks Claude Code one line and previews the call in full", async () => {
  expect(
    await askedAbout("reply-review", "mcp/slack/send_message", {
      channel: "#general",
      text: "Hello",
    }),
  ).toEqual({
    question: "Full review text.",
    shortQuestion: "Approve the slack__send_message call?",
    callPreview: [
      "**slack\\_\\_send\\_message call**",
      "```yaml\nchannel: '#general'\ntext: Hello\n```",
    ].join("\n\n"),
    header: "Approval",
    options: [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ],
    allowMultiple: false,
    remedy_offer_ids: ["offer-1"],
  });
});

test("shows a command in full under its description, wrapped to the pane", async () => {
  const command = "rm -rf __pycache__ && echo **done** `whoami`\n```\nEOF";
  const asked = await askedAbout("command-call", "Bash", {
    command,
    description: "Clean up,\n  then report",
    timeout: 60000,
  });
  expect(asked?.shortQuestion).toBe("Approve the Bash command?");
  expect(asked?.callPreview).toBe(
    [
      "**Bash command**\n*Clean up, then report*",
      // A wrapped line continues four spaces further in.
      "````sh\nrm -rf __pycache__ && echo\n    **done** `whoami`\n```\nEOF\n````",
      "```yaml\ntimeout: 60000\n```",
    ].join("\n\n"),
  );
});

test("wraps every line of a long command to the narrowest pane", async () => {
  const command = Array.from({ length: 15 }, (_, i) => `--flag${i}`).join(" ");
  const asked = await askedAbout("long-command", "Bash", { command });
  const lines = (asked?.callPreview ?? "")
    .split("```sh\n")[1]
    .split("\n```")[0]
    .split("\n");
  expect(lines.length).toBeGreaterThan(2);
  expect(lines.every((line) => line.length <= 34)).toBe(true);
  expect(lines.join("\n").replace(/\n {4}/g, " ")).toBe(command);
});

test("shows a file write as the file's content", async () => {
  const content = "export const answer = 42;\n";
  const asked = await askedAbout("write-call", "Write", {
    file_path: "src/answer.ts",
    content,
  });
  expect(asked?.callPreview).toBe(
    `**Write call**\n*src/answer.ts*\n\n\`\`\`ts\n${content}\n\`\`\``,
  );
});

test("shows an edit as a diff, one per edit", async () => {
  const edit = await askedAbout("edit-call", "Edit", {
    file_path: "src/answer.ts",
    old_string: "const answer = 41;",
    new_string: "const answer = 42;\nconst ready = true;",
    replace_all: false,
  });
  expect(edit?.callPreview).toBe(
    [
      "**Edit call**\n*src/answer.ts*",
      "```diff\n-const answer = 41;\n+const answer = 42;\n+const ready = true;\n```",
      "```yaml\nreplace_all: false\n```",
    ].join("\n\n"),
  );

  const multi = await askedAbout("multi-edit-call", "MultiEdit", {
    file_path: "a.py",
    edits: [
      { old_string: "a = 1", new_string: "a = 2" },
      { old_string: "b = 1", new_string: "b = 2" },
    ],
  });
  expect(multi?.callPreview).toBe(
    [
      "**MultiEdit call**\n*a.py*",
      "```diff\n-a = 1\n+a = 2\n```",
      "```diff\n-b = 1\n+b = 2\n```",
    ].join("\n\n"),
  );
});

test("shows any other call's arguments in full as YAML", async () => {
  const title = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
  const asked = await askedAbout("yaml-call", "mcp/github/create_issue", {
    title,
    body: "Line one with `code`\n\n  indented line\nlast line",
    labels: ["bug", "ui"],
    assignee: { login: "octocat" },
  });
  const block = (asked?.callPreview ?? "")
    .split("```yaml\n")[1]
    .split("\n```")[0];
  expect(block.split("\n").every((line) => line.length <= 34)).toBe(true);
  // A long value wraps and continues four spaces further in.
  expect(block.replace(/\n {4}(?=word)/g, " ")).toContain(`title: ${title}\n`);
  expect(block).toContain(
    "body: |-\n  Line one with `code`\n\n    indented line\n  last line\n",
  );
  expect(block).toContain(
    "labels:\n  - bug\n  - ui\nassignee:\n  login: octocat",
  );
});

test.each([
  ["no arguments", undefined],
  ["empty arguments", "{}"],
])("says the call has no arguments when the review has %s", async (_, reviewedArguments) => {
  const active = session("bare-call");
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
  expect(question?.shortQuestion).toBe("Approve the local_tool call?");
  expect(question?.callPreview).toBe(
    "**local\\_tool call**\n\nThis call has no arguments.",
  );
});

test.each([
  "[1,2]",
  "{incomplete JSON",
])("never treats unparsed arguments as an empty call: %s", async (raw) => {
  const active = session("unparsed-review");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "raw",
      text: "Full policy review.",
      tool: "example_tool",
      arguments: raw,
    },
  });
  const asked = await getHitlAskUserArguments({
    session: active,
    offerIds: ["raw"],
  });
  expect(asked?.question).toContain(raw);
  expect(asked?.question).toContain("Full policy review.");
  expect(asked?.callPreview).toBeUndefined();
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
    expectedAccepted: "",
  },
  {
    case: "more than the person's attention",
    coverage:
      "  - attention: human-approval\n  - the readers must be the public audience",
    expected:
      "Approve send_report?\n\nApproving also accepts:\n  - the readers must be the public audience\n\nto  finance@example.com\n\nApprove lets this exact call run. Deny keeps it blocked.",
    expectedAccepted:
      "\n\nApproving also accepts:\n• the readers must be the public\n  audience",
  },
])("asks about the call itself when the ruling covers $case", async ({
  coverage,
  expected,
  expectedAccepted,
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
  expect(question?.shortQuestion).toBe("Approve the send_report call?");
  expect(question?.callPreview).toBe(
    `**send\\_report call**\n\n\`\`\`yaml\nto: finance@example.com\n\`\`\`${expectedAccepted}`,
  );
});

describe.each([
  // `title` is the tool label as the preview's markdown writes it.
  { adapter: new AppaClaudeCodeAdapter(), tool: "Bash", title: "Bash" },
  {
    adapter: new AppaCodexAdapter(),
    tool: "exec_command",
    title: "exec\\_command",
  },
  { adapter: new AppaOpenCodeAdapter(), tool: "bash", title: "bash" },
])("$tool approval questions", ({ adapter, tool, title }) => {
  test.each([
    { label: "Approve", ruling: "approve" },
    { label: "Deny", ruling: "deny" },
  ] as const)("shows the command once and reads $label for that exact question", async ({
    label,
    ruling,
  }) => {
    const active = session("command-review");
    await stageHitlReview({
      session: active,
      review: {
        offerId: "offer-1",
        text: runtimeReview("  - the readers must be the public audience"),
        tool,
        // The runtime returns the arguments as the proxy evaluated them.
        arguments: JSON.stringify({
          cmd: 'git push -u origin "feature"',
          command: 'git push -u origin "feature"',
          description: "Push the branch",
        }),
      },
    });

    const question = await getHitlAskUserArguments({
      session: active,
      offerIds: ["offer-1"],
    });
    const argumentLines =
      'command      git push -u origin "feature"\ndescription  Push the branch';
    expect(question?.question).toBe(
      `Approve ${tool}?\n\nApproving also accepts:\n  - the readers must be the public audience\n\n${argumentLines}\n\nApprove lets this exact call run. Deny keeps it blocked.`,
    );
    expect(question?.callPreview).toBe(
      `**${title} command**\n*Push the branch*\n\n\`\`\`sh\ngit push -u origin "feature"\n\`\`\`\n\nApproving also accepts:\n• the readers must be the public\n  audience`,
    );
    if (!question) throw new Error("Missing review question");
    const nativeQuestion = adapter.nativeQuestion;
    const asked = nativeQuestion.fromAskUser(question).questions[0];
    expect(asked.header).toBe("Approval");
    const options = [
      { label: "Approve", description: "Allow this exact tool call." },
      { label: "Deny", description: "Keep this tool call blocked." },
    ];
    if (adapter.id === "claude-code") {
      expect(asked.question).toBe(`Approve the ${tool} command?`);
      expect(asked.options).toEqual(
        options.map((option) => ({ ...option, preview: question.callPreview })),
      );
    } else {
      expect(asked.question).toBe(question.question);
      expect(asked.options).toEqual(options);
    }
    if (adapter.id === "codex")
      expect(asked).toHaveProperty("id", "archestra_question");
    if (adapter.id === "opencode")
      expect(asked).toHaveProperty("multiple", false);
    const content =
      adapter.id === "codex"
        ? JSON.stringify({
            answers: { archestra_question: { answers: [label] } },
          })
        : adapter.id === "opencode"
          ? `User has answered your questions: "${asked.question}"="${label}". You can now continue with the user's answers in mind.`
          : `Your questions have been answered: "${asked.question}"="${label}". You can now continue with these answers in mind.`;
    expect(nativeQuestion.rulingFromResult({ content }, question)).toBe(ruling);
    if (adapter.id === "opencode") {
      expect(
        nativeQuestion.rulingFromResult(
          {
            content: `User has answered your questions: "Approve ${tool}?"="${label}". You can now continue with the user's answers in mind.`,
          },
          question,
        ),
      ).toBe("unrecognized");
    }
    expect(
      await recordHitlRuling({ session: active, offerId: "offer-1", ruling }),
    ).toBe(true);
    expect(
      await consumeHitlRuling({ session: active, offerId: "offer-1" }),
    ).toBe(ruling);
    expect(
      await consumeHitlRuling({ session: active, offerId: "offer-1" }),
    ).toBeUndefined();
  });
});

test("asks the full question when Claude Code would withhold the preview", async () => {
  const active = session("long-question");
  const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: runtimeReview("  - the readers must be the public audience"),
      tool: "mcp/slack/send_message",
      arguments: JSON.stringify({ text }),
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  if (!question) throw new Error("Missing review question");
  // Longer than the 2,000 characters Claude Code shows of a preview.
  expect(question.callPreview?.length).toBeGreaterThan(2000);
  for (const adapter of [
    new AppaClaudeCodeAdapter(),
    new AppaCodexAdapter(),
    new AppaOpenCodeAdapter(),
  ]) {
    const asked = adapter.nativeQuestion.fromAskUser(question).questions[0];
    expect(asked.question).toBe(question.question);
    const fullArgs = asked.question
      .split("Full arguments (YAML, not summarized):\n")[1]
      .split("\n\nApprove lets")[0];
    expect(loadYaml(fullArgs)).toEqual({ text });
    // Keep coverage in the prefix even for clients that truncate long questions.
    expect(asked.question.length).toBeGreaterThan(2000);
    expect(asked.question.slice(0, 2000)).toContain(
      "the readers must be the public audience",
    );
    expect(asked.question.slice(0, 2000)).toContain("text: word0");
    for (const option of asked.options)
      expect(option).not.toHaveProperty("preview");
  }
});

test("asks the full question when the preview has control characters", async () => {
  const asked = await askedAbout("control-question", "Bash", {
    command: "printf '\u001b[31mred\u001b[0m'",
  });
  if (!asked) throw new Error("Missing review question");
  const [question] = new AppaClaudeCodeAdapter().nativeQuestion.fromAskUser(
    asked,
  ).questions as Array<{ question: string; options: object[] }>;
  expect(question.question).toBe(asked.question);
  for (const option of question.options)
    expect(option).not.toHaveProperty("preview");
});

test("pretty-printed long arguments round-trip without loss when summarization is unavailable", async () => {
  const active = session("pretty-long-fallback");
  const args = {
    message: `# Work order\n\n${"Preserve this exact sentence. ".repeat(100)}\n\n  indentation\n\tand tabs\n`,
    command: "printf 'a  b'\nexit 0",
    nested: { enabled: true },
  };
  await stageHitlReview({
    session: active,
    review: {
      offerId: "pretty",
      tool: "start_run",
      text: runtimeReview(
        "  - attention: human-approval\n  - trust must reach trusted",
      ),
      arguments: JSON.stringify(args),
    },
  });
  const asked = await getHitlAskUserArguments({
    session: active,
    offerIds: ["pretty"],
  });
  if (!asked) throw new Error("expected the full pending review");
  const full = asked.question
    .split("Full arguments (YAML, not summarized):\n")[1]
    .split("\n\nApprove lets this exact call run.")[0];
  expect(loadYaml(full ?? "")).toEqual(args);
  expect(asked?.question).toContain("trust must reach trusted");
  const native = new AppaClaudeCodeAdapter().nativeQuestion.fromAskUser(asked);
  expect(native.questions[0].question).toBe(asked?.question);
  expect(
    native.questions[0].options.every((option) => !("preview" in option)),
  ).toBe(true);
});

test("keeps both arguments when a command tool's cmd and command differ", async () => {
  const active = session("distinct-command-review");
  await stageHitlReview({
    session: active,
    review: {
      offerId: "offer-1",
      text: runtimeReview("  - attention: human-approval"),
      tool: "exec_command",
      arguments: JSON.stringify({ cmd: "ls", command: "rm -rf build" }),
    },
  });

  const question = await getHitlAskUserArguments({
    session: active,
    offerIds: ["offer-1"],
  });
  expect(question?.callPreview).toBe(
    "**exec\\_command command**\n\n```sh\nrm -rf build\n```\n\n```yaml\ncmd: ls\n```",
  );
  expect(question?.question).toContain("cmd      ls\ncommand  rm -rf build");
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
