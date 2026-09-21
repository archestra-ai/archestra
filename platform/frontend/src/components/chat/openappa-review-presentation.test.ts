import { describe, expect, it } from "vitest";
import {
  parseJsonArguments,
  parseReviewPresentation,
  reviveJsonStrings,
} from "./openappa-review-presentation";

describe("reviveJsonStrings", () => {
  it("parses a JSON array that arrived as an escaped string", () => {
    expect(
      reviveJsonStrings({
        todos: '[{"id": 1, "content": "qa-hitl", "status": "pending"}]',
      }),
    ).toEqual({
      todos: [{ id: 1, content: "qa-hitl", status: "pending" }],
    });
  });

  it("leaves ordinary strings alone", () => {
    expect(reviveJsonStrings({ path: "/tmp/notes.md" })).toEqual({
      path: "/tmp/notes.md",
    });
  });
});

describe("parseJsonArguments", () => {
  it("returns the raw text when the payload is not JSON", () => {
    expect(parseJsonArguments("not json")).toBe("not json");
  });
});

describe("parseReviewPresentation", () => {
  const message = [
    'APPA asks you to rule as the authority "operator".',
    "",
    "Tool: mcp/archestra/todo_write",
    "Arguments:",
    "{",
    '  "todos": "[{\\"id\\": 1, \\"content\\": \\"qa-hitl\\", \\"status\\": \\"pending\\"}]"',
    "}",
    "",
    "What this ruling would cover:",
    "  attention: signoff",
  ].join("\n");

  it("pretty-parses nested JSON argument strings from the review text", () => {
    expect(parseReviewPresentation({ message })).toEqual({
      intro: 'APPA asks you to rule as the authority "operator".',
      tool: "mcp/archestra/todo_write",
      arguments: {
        todos: [{ id: 1, content: "qa-hitl", status: "pending" }],
      },
      rest: "What this ruling would cover:\n  attention: signoff",
    });
  });

  it("prefers structured tool and arguments from the stream over the text", () => {
    expect(
      parseReviewPresentation({
        message,
        reviewedTool: "archestra__whoami",
        reviewedArguments: '{"user":"admin"}',
      }),
    ).toMatchObject({
      tool: "archestra__whoami",
      arguments: { user: "admin" },
    });
  });
});
