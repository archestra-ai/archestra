// @vitest-environment node
import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  omitRepeatedPolicyDiffs,
  PolicyDiffReferenceCollector,
} from "./policy-diff-deduplication";

const change = {
  stage: "preview",
  delivery: "revision",
  path: "organization.appa.toml",
  before: '[policy]\nvalue = "old"\n',
  after: '[policy]\nvalue = "new"\n',
  diff: '@@ -1,2 +1,2 @@\n [policy]\n-value = "old"\n+value = "new"\n',
};
const snippet = '[policy]\n-value = "old"\n+value = "new"';
const repeated = `Explanation.\n\n\`\`\`diff\n${snippet}\n\`\`\`\n\nPlease review.`;
const shortName = (name: string) => {
  if (name === "archestra__preview_guardrails_policy_change")
    return "preview_guardrails_policy_change";
  if (name === "archestra__run_tool") return "run_tool";
  return null;
};
const preview = (
  output: unknown = { structuredContent: change },
): UIMessage => ({
  id: "preview",
  role: "assistant",
  parts: [
    {
      type: "tool-archestra__preview_guardrails_policy_change",
      toolCallId: "preview-call",
      state: "output-available",
      input: {},
      output,
    },
  ],
});
const answer: UIMessage = {
  id: "answer",
  role: "assistant",
  parts: [{ type: "text", text: repeated }],
};
function collectPolicyDiffReferences(
  messages: UIMessage[],
  getToolShortName: typeof shortName,
) {
  return new PolicyDiffReferenceCollector().collect(messages, getToolShortName);
}
function references(output?: unknown) {
  return collectPolicyDiffReferences([preview(output), answer], shortName)
    .get("answer")
    ?.get(0);
}

describe("policy diff duplication", () => {
  it.each([
    { structuredContent: change },
    { content: [{ type: "text", text: JSON.stringify(change) }] },
    JSON.stringify(change),
  ])("reuses previews across the SDK's cloned streaming snapshots (%j)", (output) => {
    const collector = new PolicyDiffReferenceCollector();
    const messages = [preview(output), answer];
    const first = collector.collect(messages, shortName).get("answer")?.get(0);
    const next = collector
      .collect(structuredClone(messages), shortName)
      .get("answer")
      ?.get(0);
    expect(next).toBe(first);
  });

  it("reuses completed previews while text streams, but invalidates changed output", () => {
    const collector = new PolicyDiffReferenceCollector();
    const output = { structuredContent: change };
    const first = collector
      .collect([preview(output), answer], shortName)
      .get("answer")
      ?.get(0);
    const next = collector
      .collect(
        [
          preview(output),
          {
            ...answer,
            parts: [{ type: "text", text: `${repeated} More text.` }],
          },
        ],
        shortName,
      )
      .get("answer")
      ?.get(0);
    expect(next).toBe(first);
    const replaced = collector
      .collect(
        [
          preview({
            structuredContent: { ...change, after: "another policy" },
          }),
          answer,
        ],
        shortName,
      )
      .get("answer")
      ?.get(0);
    expect(replaced).not.toBe(first);
    expect(omitRepeatedPolicyDiffs(repeated, replaced)).toBe(repeated);
    collector.collect([], shortName);
    expect(
      collector
        .collect([preview(output), answer], shortName)
        .get("answer")
        ?.get(0),
    ).not.toBe(first);
  });

  it("matches thousands of separate hunks without blocking chat", () => {
    const lines = Array.from({ length: 31_000 }, (_, i) => `rule_${i} = "old"`);
    const before = lines.join("\n");
    const hunks: string[] = [];
    for (let i = 0; i < lines.length; i += 3) {
      const old = lines[i];
      lines[i] = `rule_${i} = "new"`;
      hunks.push(`@@ -${i + 1} +${i + 1} @@\n-${old}\n+${lines[i]}`);
    }
    const diff = hunks.join("\n");
    const refs = references({
      structuredContent: { ...change, before, after: lines.join("\n"), diff },
    });
    const start = performance.now();
    expect(omitRepeatedPolicyDiffs(`\`\`\`diff\n${diff}\n\`\`\``, refs)).toBe(
      "",
    );
    // Deliberately generous: the repeated whole-policy scans took seconds.
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it.each([
    { structuredContent: change },
    { content: [{ type: "text", text: JSON.stringify(change) }] },
    JSON.stringify(change),
  ])("removes only the repeated fence, retaining the explanation (%j)", (output) => {
    expect(omitRepeatedPolicyDiffs(repeated, references(output))).toBe(
      "Explanation.\n\n\nPlease review.",
    );
  });

  it("recognizes full hunks and tilde fences with a longer closing fence", () => {
    const text = `~~~patch\n--- a/${change.path}\n+++ b/${change.path}\n${change.diff}~~~~`;
    expect(omitRepeatedPolicyDiffs(text, references())).toBe("");
  });

  it("keeps distinct edits, distinct context, and explicitly different files", () => {
    for (const text of [
      repeated.replace('"new"', '"other"'),
      repeated.replace("[policy]", "[different]"),
      `\`\`\`diff\n--- a/another.toml\n+++ b/another.toml\n${snippet}\n\`\`\``,
    ]) {
      expect(omitRepeatedPolicyDiffs(text, references())).toBe(text);
    }
  });

  it("keeps incomplete streaming fences and diff examples inside another code block", () => {
    const incomplete = `\`\`\`diff\n${snippet}`;
    const nested = `\`\`\`\`markdown\n${repeated}\n\`\`\`\``;
    expect(omitRepeatedPolicyDiffs(incomplete, references())).toBe(incomplete);
    expect(omitRepeatedPolicyDiffs(nested, references())).toBe(nested);
  });

  it("requires an actual preceding successful preview in the same user turn", () => {
    const user: UIMessage = {
      id: "user",
      role: "user",
      parts: [{ type: "text", text: "Show another example" }],
    };
    for (const messages of [
      [answer, preview()],
      [preview(), user, answer],
      [preview({ isError: true, structuredContent: change }), answer],
    ]) {
      const refs = collectPolicyDiffReferences(messages, shortName)
        .get("answer")
        ?.get(0);
      expect(omitRepeatedPolicyDiffs(repeated, refs)).toBe(repeated);
    }
  });

  it("uses part order and handles delegated tool results with separate input/output parts", () => {
    const message: UIMessage = {
      id: "wrapped",
      role: "assistant",
      parts: [
        { type: "text", text: repeated },
        {
          type: "dynamic-tool",
          toolName: "archestra__run_tool",
          toolCallId: "wrapped-call",
          state: "input-available",
          input: { tool_name: "archestra__preview_guardrails_policy_change" },
        },
        {
          type: "dynamic-tool",
          toolName: "archestra__run_tool",
          toolCallId: "wrapped-call",
          state: "output-available",
          input: undefined,
          output: { structuredContent: change },
        },
        { type: "text", text: repeated },
      ],
    };
    const refs = collectPolicyDiffReferences([message], shortName).get(
      message.id,
    );
    expect(omitRepeatedPolicyDiffs(repeated, refs?.get(0))).toBe(repeated);
    expect(omitRepeatedPolicyDiffs(repeated, refs?.get(3))).not.toContain(
      "```",
    );
  });

  it("matches all hunks and normalizes CRLF without changing surrounding prose", () => {
    const multi = {
      ...change,
      before: "old\nmiddle\nbefore\n",
      after: "new\nmiddle\nafter\n",
      diff: "@@ -1 +1 @@\n-old\n+new\n@@ -3 +3 @@\n-before\n+after\n",
    };
    const text = `\`\`\`diff\r\n${multi.diff.replace(/\n/g, "\r\n")}\`\`\``;
    const refs = references({
      structuredContent: Object.fromEntries(
        Object.entries(multi).map(([key, value]) => [
          key,
          value.replace(/\n/g, "\r\n"),
        ]),
      ),
    });
    expect(omitRepeatedPolicyDiffs(text, refs)).toBe("");
  });
});
