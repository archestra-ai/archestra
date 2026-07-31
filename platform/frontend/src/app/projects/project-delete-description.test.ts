import { describe, expect, it } from "vitest";
import { buildProjectDeleteDescription } from "./project-delete-description";

describe("buildProjectDeleteDescription", () => {
  it("does not mention scheduled tasks when the project has none", () => {
    const text = buildProjectDeleteDescription(0);
    expect(text).toContain("chats are kept");
    expect(text).toContain("files");
    expect(text).not.toMatch(/scheduled task/i);
  });

  it("warns about a single scheduled task in the singular", () => {
    const text = buildProjectDeleteDescription(1);
    expect(text).toContain("Its 1 scheduled task stops running");
    expect(text).not.toContain("1 scheduled tasks");
  });

  it("pluralizes when several scheduled tasks are paused", () => {
    const text = buildProjectDeleteDescription(3);
    expect(text).toContain("Its 3 scheduled tasks stop running");
  });

  it("describes deletion as reversible rather than permanent", () => {
    // Deleting a project soft-deletes it, so copy promising permanence would be
    // wrong — and it is what the dialog said before Deleted Items shipped.
    const text = buildProjectDeleteDescription(2);
    expect(text).toContain("Deleted Items");
    expect(text).not.toMatch(/permanently deletes/i);
    expect(text).not.toMatch(/cannot be undone/i);
  });
});
