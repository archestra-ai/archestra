import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { openappaActor } from "./actor";
import { anchoredSessions, recordResponseAnchors } from "./context-anchors";

const organizationId = "org-anchors";
const callerId = "user:alice";
const session = (id: string) => ({
  organization_id: organizationId,
  caller_id: callerId,
  session_id: `${callerId}|${id}`,
});

async function started(id: string) {
  const value = session(id);
  await db.insert(schema.openappaSessionsTable).values({
    actor: openappaActor(value.session_id),
    root: openappaActor(value.session_id),
    organizationId,
    callerId,
    sessionId: value.session_id,
    startDecision: { decision: "ack" },
  });
}

const record = (id: string, response: unknown, requestBody: unknown = {}) =>
  recordResponseAnchors({
    session: session(id),
    family: "anthropic:messages",
    requestBody,
    response,
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

/** The history a client builds from that summary: its own preamble around the lines. */
const continued = (lines: string[]) => ({
  messages: [
    {
      role: "user",
      content: `This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n${lines.join("\n\n")}`,
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
    await started("parent");
    await record("parent", compaction);

    expect(await trace(continued(summary))).toEqual(["parent"]);
  });

  test("short lines, another caller's history and a line two sessions wrote name nothing", async () => {
    await Promise.all([started("parent"), started("other"), started("short")]);
    await record("parent", compaction);
    await record("other", { content: [{ type: "text", text: summary[1] }] });
    await record("short", { content: [{ type: "text", text: "Done." }] });

    expect(await trace(continued([summary[1]]))).toEqual([]);
    expect(await trace(continued(["Done."]))).toEqual([]);
    expect(await trace(continued(summary), "user:mallory")).toEqual([]);
    expect(await trace(continued(summary))).toEqual([]);
  });

  test("the session whose lines appear last comes last", async () => {
    const later =
      "3. Next step: the forked session continued on its own and summarized the remaining work in a paragraph of its own.";
    await Promise.all([started("parent"), started("fork")]);
    await record("parent", compaction);
    await record("fork", { content: [{ type: "text", text: later }] });

    // The fork matches only one line, so it cannot become the advisory parent.
    expect(await trace(continued([...summary, later]))).toEqual(["parent"]);
  });

  test("does not record response lines already present anywhere in the request", async () => {
    const echoed =
      "This client-injected instruction is long enough to be an anchor but must never identify a session that merely repeated it.";
    const first =
      "The first new decision is long enough to identify the session only when paired with a second independently new response line.";
    const second =
      "The second new decision makes the response a reliable context anchor for a later compaction summary.";
    await started("parent");
    await record(
      "parent",
      { content: [{ type: "text", text: [echoed, first, second].join("\n") }] },
      { system: echoed },
    );

    expect(await trace(continued([echoed]))).toEqual([]);
    expect(await trace(continued([first, second]))).toEqual(["parent"]);
  });

  test("ignores anchors from a session whose runtime never started", async () => {
    await record("tool-less", compaction);

    expect(await trace(continued(summary))).toEqual([]);
  });
});
