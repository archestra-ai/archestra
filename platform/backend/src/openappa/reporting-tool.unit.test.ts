import { describe, expect, test } from "vitest";
import { toolEntries } from "./policy-text";
import { withReportingTool } from "./reporting-tool";

const ANNOTATED_CATCH_ALL = `[policy]
version = 2

[[policy.annotator]]
name = "tool-call"
builtin = "archestra"
ranks = ["suspicious", "trusted"]
audiences = []
marks = []
effects = []

[[policy.tool]]
name = "*"
annotator = "tool-call"
`;

const accept = async () => [];

describe("withReportingTool", () => {
  test("gives yell an empty rule ahead of an annotated catch-all", async () => {
    const text = await withReportingTool({
      composed: ANNOTATED_CATCH_ALL,
      validate: accept,
    });

    expect(toolEntries(text)).toEqual([
      expect.objectContaining({
        name: "mcp/appa/yell",
        delta: {},
        annotator: undefined,
        requires: undefined,
      }),
      expect.objectContaining({ name: "*", annotator: "tool-call" }),
    ]);
  });

  test("keeps a rule the organization wrote for yell", async () => {
    const own = `${ANNOTATED_CATCH_ALL}
[[policy.tool]]
name = "mcp/appa/yell"
annotator = "tool-call"
`;

    expect(await withReportingTool({ composed: own, validate: accept })).toBe(
      own,
    );
  });

  test("keeps the composition when the runtime refuses the rule", async () => {
    const text = await withReportingTool({
      composed: ANNOTATED_CATCH_ALL,
      validate: async () => ["refused"],
    });

    expect(text).toBe(ANNOTATED_CATCH_ALL);
  });
});
