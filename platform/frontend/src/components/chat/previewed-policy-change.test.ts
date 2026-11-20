import type { UIMessage } from "@ai-sdk/react";
import type { ArchestraToolShortName } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { collectPreviewedChanges } from "./previewed-policy-change";

const PREFIX = "archestra__";
const shortName = (name: string) =>
  name.startsWith(PREFIX)
    ? (name.slice(PREFIX.length) as ArchestraToolShortName)
    : null;

const FILE = { mcpServerId: "s1", expectedCommit: "c1", content: "x\ny\n" };
const DIFF = "--- a/mcp/s.toml\n+++ b/mcp/s.toml\n@@ -1 +1,2 @@\n x\n+y\n";

/** A result as the chat stores it: the model's text copy, no full texts. */
const stored = (value: unknown) => ({
  _meta: {},
  content: JSON.stringify(value),
});

function conversation(
  preview: { output: unknown; viaRunTool?: string },
  propose: { viaRunTool?: string } = {},
): UIMessage[] {
  const call = (
    id: string,
    tool: string,
    input: unknown,
    viaRunTool: string | undefined,
    output?: unknown,
  ) => ({
    type: `tool-${PREFIX}${viaRunTool ? "run_tool" : tool}`,
    toolCallId: id,
    state: output === undefined ? "approval-requested" : "output-available",
    input: viaRunTool ? { tool_name: viaRunTool, tool_args: input } : input,
    ...(output === undefined ? {} : { output }),
  });
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [
        call(
          "preview-1",
          "preview_guardrails_server_rules_change",
          FILE,
          preview.viaRunTool,
          preview.output,
        ),
        call(
          "propose-1",
          "propose_guardrails_server_rules_change",
          { ...FILE, summary: "Allow y" },
          propose.viaRunTool,
        ),
      ],
    } as unknown as UIMessage,
  ];
}

const valid = stored({
  valid: true,
  path: "mcp/s.toml",
  diff: DIFF,
  mcpServer: { id: "s1", name: "S" },
});

describe("collectPreviewedChanges", () => {
  it("points a proposal at the preview of the same file, called directly or through run_tool under either name", () => {
    expect(
      collectPreviewedChanges(conversation({ output: valid }), shortName).get(
        "propose-1",
      ),
    ).toMatchObject({ output: valid });
    for (const name of [
      "propose_guardrails_server_rules_change",
      `${PREFIX}propose_guardrails_server_rules_change`,
    ])
      expect(
        collectPreviewedChanges(
          conversation(
            {
              output: valid,
              viaRunTool: "preview_guardrails_server_rules_change",
            },
            { viaRunTool: name },
          ),
          shortName,
        ).has("propose-1"),
      ).toBe(true);
  });

  it("reads run_tool arguments sent as JSON text, as run_tool itself does", () => {
    const messages = conversation(
      { output: valid, viaRunTool: "preview_guardrails_server_rules_change" },
      { viaRunTool: "propose_guardrails_server_rules_change" },
    );
    for (const part of messages[0].parts as unknown as Array<{
      input: { tool_args: unknown };
    }>)
      part.input.tool_args = JSON.stringify(part.input.tool_args);
    expect(collectPreviewedChanges(messages, shortName).has("propose-1")).toBe(
      true,
    );
  });

  it("leaves a proposal unmatched when another file was previewed after its own", () => {
    const messages = conversation({ output: valid });
    const parts = messages[0].parts as unknown as Array<
      Record<string, unknown>
    >;
    // A second preview, of another file, between the first one and the proposal.
    parts.splice(1, 0, {
      ...parts[0],
      toolCallId: "preview-2",
      input: { ...FILE, content: "x\nz\n" },
      output: stored({
        valid: true,
        diff: "--- a/mcp/s.toml\n+++ b/mcp/s.toml\n@@ -1 +1,2 @@\n x\n+z\n",
        mcpServer: { id: "s1", name: "S" },
      }),
    });
    expect(collectPreviewedChanges(messages, shortName).size).toBe(0);
  });

  it("leaves a proposal unmatched when its preview put no diff on screen", () => {
    for (const output of [
      // An error text in place of a result.
      "The policy repository could not be read.",
      // A preview the validation refused.
      stored({
        valid: false,
        errors: ["unknown tool"],
        diff: DIFF,
        mcpServer: { id: "s1", name: "S" },
      }),
      // A diff that does not fit the file sent.
      stored({
        valid: true,
        diff: "--- a/f\n+++ b/f\n@@ -1 +1,2 @@\n other\n+y\n",
        mcpServer: { id: "s1", name: "S" },
      }),
    ])
      expect(
        collectPreviewedChanges(conversation({ output }), shortName).size,
      ).toBe(0);
  });
});
