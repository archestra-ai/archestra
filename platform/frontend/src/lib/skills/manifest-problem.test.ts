import { describe, expect, it } from "vitest";
import { parseSkillManifestProblem } from "./manifest-problem";

const refusal = (error: Record<string, unknown>) => ({ error });

describe("parseSkillManifestProblem", () => {
  it("reads the line and the reason from a refused save", () => {
    expect(
      parseSkillManifestProblem(
        refusal({
          message: "Not valid YAML (line 3).",
          type: "api_validation_error",
          internal_code: "skill_manifest_invalid",
          details: { line: 3 },
        }),
        "---\nname: x\n",
      ),
    ).toEqual({
      line: 3,
      message: "Not valid YAML (line 3).",
      manifest: "---\nname: x\n",
    });
  });

  it.each([
    ["another refusal", { message: "Taken", type: "api_conflict_error" }],
    [
      "the code without a line",
      { message: "Bad", internal_code: "skill_manifest_invalid" },
    ],
    [
      "a line that is not one",
      {
        message: "Bad",
        internal_code: "skill_manifest_invalid",
        details: { line: 0 },
      },
    ],
  ])("is null for %s", (_label, error) => {
    expect(parseSkillManifestProblem(refusal(error), "")).toBeNull();
  });

  it("is null for something that is not an API error", () => {
    expect(parseSkillManifestProblem(new Error("offline"), "")).toBeNull();
    expect(parseSkillManifestProblem(undefined, "")).toBeNull();
  });
});
