import { describe, expect, it } from "vitest";
import {
  withEditorClosed,
  withEditorOpen,
  withOpenEditRewritten,
} from "./editor-url";

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

describe("withEditorOpen", () => {
  it("sets edit while preserving table params", () => {
    const next = withEditorOpen(tableParams(), "skill-1");
    expect(next.get("edit")).toBe("skill-1");
    expectTableParamsPreserved(next);
  });

  it("replaces an existing edit param", () => {
    const next = withEditorOpen(tableParams({ edit: "old" }), "skill-2");
    expect(next.getAll("edit")).toEqual(["skill-2"]);
  });

  it("does not mutate its input", () => {
    const input = tableParams();
    withEditorOpen(input, "skill-1");
    expect(input.get("edit")).toBeNull();
  });
});

describe("withEditorClosed", () => {
  it("removes only the edit param, preserving table params", () => {
    const next = withEditorClosed(tableParams({ edit: "skill-1" }));
    expect(next.get("edit")).toBeNull();
    expectTableParamsPreserved(next);
  });

  it("is a no-op when edit is absent", () => {
    const next = withEditorClosed(tableParams());
    expect(next.toString()).toBe(tableParams().toString());
  });

  it("does not mutate its input", () => {
    const input = tableParams({ edit: "skill-1" });
    withEditorClosed(input);
    expect(input.get("edit")).toBe("skill-1");
  });
});

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
