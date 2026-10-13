// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getReviewCardView,
  getReviewDecisionContent,
  parseJsonArguments,
  parseReviewPresentation,
  REVIEW_STATUS_DESCRIPTION,
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

describe("getReviewCardView", () => {
  it("shows the tool card with parsed arguments and the standard prompt", () => {
    expect(
      getReviewCardView({
        message: "APPA asks you to rule.",
        reviewedTool: "archestra__whoami",
        reviewedArguments: '{"user":"admin"}',
      }),
    ).toEqual({
      toolCard: { title: "archestra__whoami", input: { user: "admin" } },
      description: REVIEW_STATUS_DESCRIPTION,
    });
  });

  it("keeps the tool card without arguments when only a tool is named", () => {
    expect(getReviewCardView({ message: "Tool: archestra__whoami" })).toEqual({
      toolCard: { title: "archestra__whoami" },
      description: REVIEW_STATUS_DESCRIPTION,
    });
  });

  it("falls back to the review text when no tool parses", () => {
    expect(
      getReviewCardView({ message: "  Allow the agent to continue?  " }),
    ).toEqual({ description: "Allow the agent to continue?" });
  });

  it("uses the standard prompt for an empty review text", () => {
    expect(getReviewCardView({ message: "" })).toEqual({
      description: REVIEW_STATUS_DESCRIPTION,
    });
  });
});

describe("getReviewDecisionContent", () => {
  const requestedSchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["approve", "deny"] },
    },
    required: ["action"],
  };

  it("answers the schema's action field with the decision", () => {
    expect(
      getReviewDecisionContent({ requestedSchema, decision: "approve" }),
    ).toEqual({ action: "approve" });
    expect(
      getReviewDecisionContent({ requestedSchema, decision: "deny" }),
    ).toEqual({ action: "deny" });
  });

  it("uses the field whose enum offers the decision", () => {
    expect(
      getReviewDecisionContent({
        requestedSchema: {
          properties: { ruling: { enum: ["approve", "deny"] } },
        },
        decision: "deny",
      }),
    ).toEqual({ ruling: "deny" });
  });

  it("defaults to the action field when the schema is missing", () => {
    expect(
      getReviewDecisionContent({
        requestedSchema: undefined,
        decision: "deny",
      }),
    ).toEqual({ action: "deny" });
  });
});
