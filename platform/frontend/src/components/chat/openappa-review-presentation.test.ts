// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getReviewCardView,
  getReviewDecisionContent,
  parseJsonArguments,
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

describe("getReviewCardView", () => {
  it("shows the tool card with parsed arguments and the standard prompt", () => {
    expect(
      getReviewCardView({
        message: "Approve this call?",
        reviewedTool: "archestra__todo_write",
        reviewedArguments: JSON.stringify({
          todos: '[{"id": 1, "content": "qa-hitl", "status": "pending"}]',
        }),
        reviewedCoverage: [],
      }),
    ).toEqual({
      toolCard: {
        title: "archestra__todo_write",
        input: { todos: [{ id: 1, content: "qa-hitl", status: "pending" }] },
      },
      description: REVIEW_STATUS_DESCRIPTION,
    });
  });

  it("lists what approving also accepts", () => {
    expect(
      getReviewCardView({
        message: "Approve Bash?",
        reviewedTool: "Bash",
        reviewedCoverage: ["first", "second"],
      }),
    ).toEqual({
      toolCard: { title: "Bash" },
      description: [
        REVIEW_STATUS_DESCRIPTION,
        "Approving also accepts:\n  - first\n  - second",
      ].join("\n\n"),
    });
  });

  it("shows the review text when what approving accepts is unknown", () => {
    expect(
      getReviewCardView({
        message: "Approve Bash?",
        reviewedTool: "Bash",
        reviewedText: "  The whole review.  ",
      }),
    ).toEqual({
      toolCard: { title: "Bash" },
      description: [REVIEW_STATUS_DESCRIPTION, "The whole review."].join(
        "\n\n",
      ),
    });
  });

  it("shows the message of a request that carries neither coverage nor text", () => {
    expect(
      getReviewCardView({ message: "Old review.", reviewedTool: "Bash" }),
    ).toEqual({
      toolCard: { title: "Bash" },
      description: [REVIEW_STATUS_DESCRIPTION, "Old review."].join("\n\n"),
    });
  });

  it("falls back to the message when the review names no tool", () => {
    expect(
      getReviewCardView({ message: "  Allow the agent to continue?  " }),
    ).toEqual({ description: "Allow the agent to continue?" });
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
