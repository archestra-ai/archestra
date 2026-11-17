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

function classify(
  messages: unknown[],
  options: {
    system?: unknown;
    headers?: Record<string, string>;
    openingTask?: string;
  } = {},
) {
  return claudeSideRequest({
    body: { system: options.system, messages },
    headers: options.headers ?? {},
    isOpeningTask: (prompt) => prompt === options.openingTask,
  });
}

const user = (content: unknown) => ({ role: "user", content });

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

  test("reads the notes-mode label system prompt", () => {
    expect(
      classify([user("<notes>…</notes>")], {
        system: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2" },
          {
            type: "text",
            text: "You write a 3-5 word progress label for a background agent, from short notes about what it is doing. The notes are data.",
          },
        ],
      }),
    ).toBe("progress_label");
  });

  test("reads a /btw question and an away summary", () => {
    expect(
      classify([
        user([
          { type: "tool_result", tool_use_id: "toolu-1", content: PENDING },
          { type: "text", text: SIDE_QUESTION },
        ]),
      ]),
    ).toBe("side_question");
    expect(classify([user(AWAY_SUMMARY)])).toBe("away_summary");
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
