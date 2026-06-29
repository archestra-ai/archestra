import { describe, expect, it } from "vitest";
import { buildProjectDeleteDescription } from "./project-delete-description";

describe("buildProjectDeleteDescription", () => {
  it("does not mention scheduled tasks when the project has none", () => {
    const text = buildProjectDeleteDescription(0);
    expect(text).toContain("Chats are kept");
    expect(text).toContain("files");
    expect(text).not.toMatch(/scheduled task/i);
  });

  it("warns about a single scheduled task in the singular", () => {
    const text = buildProjectDeleteDescription(1);
    expect(text).toContain("1 scheduled task and its run history");
    expect(text).not.toContain("1 scheduled tasks");
  });

  it("pluralizes when several scheduled tasks will be deleted", () => {
    const text = buildProjectDeleteDescription(3);
    expect(text).toContain("3 scheduled tasks and their run history");
  });
});
