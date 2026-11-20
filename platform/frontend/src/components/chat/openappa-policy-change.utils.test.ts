import { describe, expect, it } from "vitest";
import {
  parsePolicyChange,
  textBeforeDiff,
} from "./openappa-policy-change.utils";

const BEFORE = "a\nb\nc\nd\ne\nf\ng\nh\n";
const AFTER = "a\nB\nc\nd\ne\nf\ng\nh\nnew\n";
// Trimmed to its hunks, as the backend sends it.
const DIFF = [
  "--- a/mcp/helpdesk.toml",
  "+++ b/mcp/helpdesk.toml",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "@@ -7,2 +7,3 @@",
  " g",
  " h",
  "+new",
  "",
].join("\n");

describe("textBeforeDiff", () => {
  it("puts removed lines back and takes added ones out, hunk by hunk", () => {
    expect(textBeforeDiff(AFTER, DIFF)).toBe(BEFORE);
  });

  it("reads a new file as nothing before it", () => {
    expect(
      textBeforeDiff("x\ny\n", "--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+x\n+y\n"),
    ).toBe("");
  });

  it("puts a deleted file back", () => {
    expect(
      textBeforeDiff("", "--- a/f\n+++ b/f\n@@ -1,2 +0,0 @@\n-x\n-y\n"),
    ).toBe("x\ny\n");
  });

  it("refuses a diff that does not fit the text", () => {
    expect(textBeforeDiff("other\n", DIFF)).toBeNull();
  });
});

describe("parsePolicyChange", () => {
  // What a chat stores when its transport kept only the model's copy of the
  // result: the diff, never the two texts.
  const stored = (result: Record<string, unknown>) => ({
    _meta: { archestraExecutedAs: { kind: "platform" } },
    content: JSON.stringify(result),
  });

  it("reads a server's rules preview stored without its texts, from the diff and the file the call sent", () => {
    const change = parsePolicyChange(
      stored({
        stage: "preview",
        delivery: "pull_request",
        mcpServer: { id: "s", name: "Helpdesk" },
        path: "mcp/helpdesk.toml",
        diff: DIFF,
        valid: true,
      }),
      false,
      { mcpServerId: "s", content: AFTER, expectedCommit: "c" },
    );
    expect(change).toMatchObject({
      delivery: "pull_request",
      before: BEFORE,
      after: AFTER,
      path: "mcp/helpdesk.toml",
    });
  });

  it("reads a preview from before its result named the delivery, and one sent through run_tool", () => {
    expect(
      parsePolicyChange(
        stored({
          stage: "preview",
          mcpServer: { id: "s", name: "Helpdesk" },
          path: "mcp/helpdesk.toml",
          diff: "--- a/f\n+++ b/f\n@@ -0,0 +1,1 @@\n+x\n",
        }),
        false,
        { tool_name: "archestra__preview", tool_args: { content: "x\n" } },
      ),
    ).toMatchObject({ delivery: "pull_request", before: "", after: "x\n" });
  });

  it("prefers the texts a result carries over rebuilding them", () => {
    expect(
      parsePolicyChange({
        structuredContent: {
          delivery: "revision",
          before: "old\n",
          after: "new\n",
          diff: "garbage",
        },
      }),
    ).toMatchObject({ before: "old\n", after: "new\n" });
  });

  it("is no policy change without a delivery, a file, or a way back to the text before", () => {
    expect(parsePolicyChange(stored({ rows: [1, 2] }))).toBeNull();
    expect(
      parsePolicyChange(stored({ delivery: "pull_request", diff: DIFF })),
    ).toBeNull();
    expect(
      parsePolicyChange(stored({ delivery: "pull_request" }), false, {
        content: "x\n",
      }),
    ).toBeNull();
  });
});
