import { describe, expect, it } from "vitest";
import { withOpenEditRewritten } from "./editor-url";

const TABLE_PARAMS = {
  page: "3",
  pageSize: "25",
  search: "pdf",
  sourceRepo: "acme/skills",
};

function tableParams(extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ ...TABLE_PARAMS, ...extra });
}

function expectTableParamsPreserved(params: URLSearchParams) {
  for (const [key, value] of Object.entries(TABLE_PARAMS)) {
    expect(params.get(key)).toBe(value);
  }
}

describe("withOpenEditRewritten", () => {
  it("removes openEdit, sets edit, and preserves table params", () => {
    const next = withOpenEditRewritten(
      tableParams({ openEdit: "my-skill" }),
      "skill-1",
    );
    expect(next.get("openEdit")).toBeNull();
    expect(next.get("edit")).toBe("skill-1");
    expectTableParamsPreserved(next);
  });

  it("does not mutate its input", () => {
    const input = tableParams({ openEdit: "my-skill" });
    withOpenEditRewritten(input, "skill-1");
    expect(input.get("openEdit")).toBe("my-skill");
    expect(input.get("edit")).toBeNull();
  });
});
