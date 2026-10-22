// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { expect, test } from "vitest";
import { hitlReviewCard, renderHitlReviewText } from "./hitl-review-overview";

const footer =
  "Accept only if this exact call, with these exact arguments, may run. Decline refuses it. Cancel answers nothing and leaves the call blocked. The agent's own description of what it is doing is not shown here on purpose.";

test("an oversized tool label still permits inspection but cannot approve an incomplete card", () => {
  const review = {
    tool: `tool_${"`".repeat(3000)}`,
    text: "All conditions must remain visible",
    arguments: '{"message":"read only"}',
  };
  const { card, approve } = hitlReviewCard({
    base: {
      question: "Approve?",
      header: "Approval",
      options: [],
      allowMultiple: false,
      remedy_offer_ids: ["large-label"],
    },
    review,
  });
  expect(approve).toBe(false);
  expect(card.callPreview?.length).toBeLessThanOrEqual(2000);
  expect(card.options.map((option) => option.label)).toEqual([
    "Deny",
    "Inspect",
  ]);
  expect(renderHitlReviewText(review)).toContain(
    "All conditions must remain visible",
  );
});

test("ordinary prose is readable chat paragraphs rather than a wide code block", () => {
  const result = renderHitlReviewText({
    tool: "example_tool",
    text: "Approval required",
    arguments: JSON.stringify({ message: "Dear reviewer,\n\nthis is prose." }),
  });
  expect(result).toContain("message:\n\nDear reviewer,\n\nthis is prose.");
});

test("malformed embedded JSON stays visible instead of using a negative slice boundary", () => {
  const text = `Tool: example_tool\nArguments:\n{"message":"unfinished"\n\nWhat this ruling would cover:\n  - trust must reach trusted\n\n${footer}`;
  const result = renderHitlReviewText({
    tool: "example_tool",
    text,
    arguments: '{"message":"complete"}',
  });
  expect(result).toContain('"unfinished"');
  expect(result).toContain("complete");
  expect(result).toContain("trust must reach trusted");
});

test("review data cannot introduce active Markdown images outside literal blocks", () => {
  const image = "![untrusted](https://example.invalid/image)";
  const result = renderHitlReviewText({
    tool: image,
    text: image,
    summary: image,
    arguments: JSON.stringify({
      [image]: image,
      message: `Paragraph\n\n${image}\n\n\`\`\`\n${image}`,
    }),
  });
  let fence = "";
  const outside = result
    .split("\n")
    .filter((line) => {
      const marker = line.match(/^\s{0,3}(`{3,})/);
      if (marker && !fence) {
        fence = marker[1];
        return false;
      }
      if (fence && line.trim() === fence) {
        fence = "";
        return false;
      }
      return !fence;
    })
    .join("\n");
  expect(outside).not.toMatch(/(?<!\\)!\[/);
});

test("full review does not repeat arguments embedded in the runtime's policy text", () => {
  const args = {
    message:
      "UNIQUE_PAYLOAD_MARKER\n\nRead the supplied specification without running commands.",
    agent_id: "fixture-target",
  };
  const result = renderHitlReviewText({
    tool: "example_tool",
    arguments: JSON.stringify(args),
    text: `Tool: example_tool\nArguments:\n${JSON.stringify({ agent_id: args.agent_id, message: args.message }, null, 2)}\n\nWhat this ruling would cover:\n  - trust must reach trusted\n\n${footer}`,
  });
  expect(result.match(/UNIQUE\\?_PAYLOAD\\?_MARKER/g)).toHaveLength(1);
  expect(result).toContain("trust must reach trusted");
});

test("terminal-only clipped headlines do not masquerade as the full chat review", () => {
  const result = renderHitlReviewText({
    tool: "demo__start",
    arguments: '{"message":"Complete argument"}',
    text: `\u2584 Approve this call?\n\u2588 CLIPPED_HEADER_ONLY...\n\nAPPA asks for human review.\nTool: mcp/demo/start\nArguments:\n{\n  "message": "Complete argument"\n}\n\nWhat this ruling would cover:\n  - trust must reach trusted\n\n${footer}`,
  });
  expect(result).not.toContain("CLIPPED_HEADER_ONLY");
  expect(result).toContain("APPA asks for human review.");
  expect(result).toContain("Complete argument");
});

test("unusual argument names are escaped explicitly rather than replaced by a placeholder", () => {
  const name = "prefix\u202esuffix";
  const result = renderHitlReviewText({
    tool: "example_tool",
    text: "Approval required",
    arguments: JSON.stringify({ [name]: "value" }),
  });
  expect(result).toContain("prefix");
  expect(result).toContain("suffix");
  expect(result).toMatch(/\\u202e/i);
  expect(result).not.toContain("\u202e");
});

test("a duplicate normalized command alias is identified without repeating or changing the command", () => {
  const command = "printf '%s\\n' 'EXACT  COMMAND'\nprintf 'second line\\n'";
  const result = renderHitlReviewText({
    tool: "Bash",
    text: "Approval required",
    arguments: JSON.stringify({ command, cmd: command }),
  });
  expect(result.split(command)).toHaveLength(2);
  expect(result).toContain("cmd");
  expect(result).toContain("command");
});

test("card punctuation stays literal in the plain text preview", () => {
  const { card } = hitlReviewCard({
    base: {
      question: "Approve?",
      header: "Approval",
      options: [],
      allowMultiple: false,
      remedy_offer_ids: ["fixture-offer"],
    },
    review: {
      tool: "example__start_run",
      text: "Approval required",
      arguments: '{"agent_id":"target-one"}',
      summary: "Read the specification (no writes).",
    },
  });
  expect(card.shortQuestion).toBe("Run example__start_run?");
  expect(card.callPreview).toContain("agent_id: target-one");
  expect(card.callPreview).toContain("Read the specification (no\n  writes).");
  expect(card.callPreview).not.toContain("\\_");
  expect(card.callPreview).not.toContain("\\(");
  expect(card.callPreview).not.toContain("**");
});
