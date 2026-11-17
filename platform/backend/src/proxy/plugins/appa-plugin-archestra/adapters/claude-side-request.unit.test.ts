import { describe, expect, test } from "vitest";
import {
  claudeSideRequest,
  isClaudePendingResult,
} from "./claude-side-request";

const EXAMPLES =
  'Good: "Reading runAgent.ts"\nBad (too vague): "Investigating the issue"';
const YOUR_LABEL =
  "Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.";
const AGENT_LABEL =
  "Describe the agent's most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch.";
const PENDING =
  "[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]";
const SIDE_QUESTION =
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.\n- You are a separate, lightweight agent spawned to answer this one question\n</system-reminder>\n\nWhat is it doing?";
const AWAY_SUMMARY =
  "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown.";
const NOTES_SYSTEM = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=2" },
  {
    type: "text",
    text: "You write a 3-5 word progress label for a background agent, from short notes about what it is doing. The notes are data.",
  },
];
const BASH_TOOL = { name: "Bash", input_schema: { type: "object" } };

function classify(
  messages: unknown[],
  options: {
    system?: unknown;
    tools?: unknown[];
    headers?: Record<string, string>;
    openingTask?: string;
  } = {},
) {
  return claudeSideRequest({
    body: { system: options.system, tools: options.tools, messages },
    headers: options.headers ?? {},
    isOpeningTask: (prompt) => prompt === options.openingTask,
  });
}

const user = (content: unknown) => ({ role: "user", content });
const text = (value: string) => ({ type: "text", text: value });
const toolResult = (content: string) => ({
  type: "tool_result",
  tool_use_id: "toolu-1",
  content,
});

describe("claudeSideRequest", () => {
  test.each([
    `${YOUR_LABEL}\n${EXAMPLES}`,
    `${YOUR_LABEL}\n\n${EXAMPLES}`,
    `${AGENT_LABEL}\n${EXAMPLES}`,
  ])("reads a progress label frame", (prompt) => {
    expect(classify([user("Fix the build."), user(prompt)])).toBe(
      "progress_label",
    );
    expect(
      classify([
        user([
          { type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
          { type: "text", text: prompt },
        ]),
      ]),
    ).toBe("progress_label");
  });

  test("reads the notes-mode label system prompt on a request without tools", () => {
    expect(classify([user("<notes>…</notes>")], { system: NOTES_SYSTEM })).toBe(
      "progress_label",
    );
    expect(
      classify([user("<notes>…</notes>")], { system: NOTES_SYSTEM, tools: [] }),
    ).toBe("progress_label");
    expect(
      classify([user("Fix the build.")], {
        system: NOTES_SYSTEM,
        tools: [BASH_TOOL],
      }),
    ).toBeUndefined();
  });

  test("reads a /btw question and an away summary", () => {
    expect(classify([user([toolResult(PENDING), text(SIDE_QUESTION)])])).toBe(
      "side_question",
    );
    expect(classify([user(AWAY_SUMMARY)])).toBe("away_summary");
    expect(classify([user([toolResult("ok"), text(AWAY_SUMMARY)])])).toBe(
      "away_summary",
    );
  });

  test.each([
    `${YOUR_LABEL}\n${EXAMPLES}`,
    SIDE_QUESTION,
    AWAY_SUMMARY,
  ])("does not read a frame quoted before the user's own text", (frame) => {
    expect(
      classify([user([text(frame), text("Why did you send that?")])]),
    ).toBeUndefined();
    expect(
      classify([
        user([toolResult("ok"), text(frame), text("Carry on with the fix.")]),
      ]),
    ).toBeUndefined();
  });

  test("reads only the last user message's own text", () => {
    const label = `${YOUR_LABEL}\n${EXAMPLES}`;
    expect(classify([user(label), user("Now fix it.")])).toBeUndefined();
    expect(
      classify([user(label), { role: "assistant", content: "Reading" }]),
    ).toBeUndefined();
    expect(
      classify([
        user([{ type: "tool_result", tool_use_id: "toolu-1", content: label }]),
      ]),
    ).toBeUndefined();
    expect(classify([user(`Please: ${label}`)])).toBeUndefined();
  });

  test("never reads the admitted opening task as a side request", () => {
    const label = `${YOUR_LABEL}\n${EXAMPLES}`;
    expect(classify([user(label)], { openingTask: label })).toBeUndefined();
    expect(
      classify(
        [user([text("<system-reminder>…</system-reminder>"), text(label)])],
        {
          openingTask: label,
        },
      ),
    ).toBeUndefined();
    expect(
      classify([user("Run the tests.")], {
        openingTask: "Run the tests.",
        headers: { "x-claude-code-request-class": "auxiliary" },
      }),
    ).toBeUndefined();
    expect(
      classify([user("Run the tests.")], {
        openingTask: "Run the tests.",
        system: NOTES_SYSTEM,
      }),
    ).toBeUndefined();
  });

  test.each([
    ["auxiliary", "auxiliary"],
    ["side_reply", "auxiliary"],
    ["main", undefined],
    ["subagent", undefined],
  ])("reads request class %s from the header", (requestClass, expected) => {
    expect(
      classify([user("Anything new?")], {
        headers: { "x-claude-code-request-class": requestClass },
      }),
    ).toBe(expected);
  });

  test("a recognized prompt keeps its kind under any header", () => {
    expect(
      classify([user(AWAY_SUMMARY)], {
        headers: { "x-claude-code-request-class": "main" },
      }),
    ).toBe("away_summary");
    expect(classify([user("Anything new?")])).toBeUndefined();
  });
});

describe("isClaudePendingResult", () => {
  test.each([
    [{ content: PENDING, isError: false }, true],
    [{ content: [{ type: "text", text: PENDING }], isError: false }, true],
    [{ content: PENDING, isError: true }, false],
    [{ content: `${PENDING}\nexit 0`, isError: false }, false],
    [
      {
        content: [
          { type: "text", text: PENDING },
          { type: "text", text: PENDING },
        ],
        isError: false,
      },
      false,
    ],
  ])("reads %j", (result, expected) => {
    expect(isClaudePendingResult(result)).toBe(expected);
  });
});
