import { describe, expect, test } from "@/test";
import { anchoredSessions, recordResponseAnchors } from "./context-anchors";

const organizationId = "org-anchors";
const callerId = "user:alice";
const session = (id: string, caller = callerId) => ({
  organization_id: organizationId,
  caller_id: caller,
  session_id: `${caller}|${id}`,
});

const summary = [
  "1. Primary Request and Intent: the user asked to read package.json and report its description, then to run a shell command.",
  "2. Security rulings: reading the file lowered the session's trust to suspicious, and the shell command was refused below the trusted floor.",
];

/** A response the way Claude writes a compaction summary. */
const compaction = {
  content: [
    {
      type: "text",
      text: `<summary>\n${summary.join("\n\n")}\n</summary>`,
    },
  ],
};

/** The history a client builds from that summary: its own preamble around the paragraphs. */
const continued = (paragraphs: string[]) => ({
  messages: [
    {
      role: "user",
      content: `This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n${paragraphs.join("\n\n")}`,
    },
    { role: "user", content: "Run this exact Bash command: echo after" },
  ],
});

const trace = (body: unknown, caller = callerId) =>
  anchoredSessions({
    organizationId,
    callerId: caller,
    family: "anthropic:messages",
    body,
  });

describe("context anchors", () => {
  test("a summary a client wraps in its own preamble still names the session that wrote it", async () => {
    await recordResponseAnchors({
      session: session("parent"),
      family: "anthropic:messages",
      response: compaction,
    });

    expect(await trace(continued(summary))).toEqual(["parent"]);
  });

  test("short paragraphs, another caller's history and a paragraph two sessions wrote name nothing", async () => {
    await recordResponseAnchors({
      session: session("parent"),
      family: "anthropic:messages",
      response: compaction,
    });
    await recordResponseAnchors({
      session: session("other"),
      family: "anthropic:messages",
      response: { content: [{ type: "text", text: summary[1] }] },
    });
    await recordResponseAnchors({
      session: session("short"),
      family: "anthropic:messages",
      response: { content: [{ type: "text", text: "Done." }] },
    });

    expect(await trace(continued([summary[1]]))).toEqual([]);
    expect(await trace(continued(["Done."]))).toEqual([]);
    expect(await trace(continued(summary), "user:mallory")).toEqual([]);
    expect(await trace(continued(summary))).toEqual(["parent"]);
  });

  test("the session whose paragraphs appear last comes last", async () => {
    const later =
      "3. Next step: the forked session continued on its own and summarized the remaining work in a paragraph of its own.";
    await recordResponseAnchors({
      session: session("parent"),
      family: "anthropic:messages",
      response: compaction,
    });
    await recordResponseAnchors({
      session: session("fork"),
      family: "anthropic:messages",
      response: { content: [{ type: "text", text: later }] },
    });

    expect(await trace(continued([...summary, later]))).toEqual([
      "parent",
      "fork",
    ]);
  });
});
