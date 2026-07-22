import { describe, expect, test } from "vitest";
import { canManageProject } from "./project-permissions";

describe("canManageProject", () => {
  test("the owner can always manage", () => {
    expect(canManageProject("owner", false)).toBe(true);
    expect(canManageProject("owner", true)).toBe(true);
  });

  test("a project:admin can manage any project they can see", () => {
    expect(canManageProject("shared", true)).toBe(true); // shared with them
    expect(canManageProject("admin", true)).toBe(true); // overseen
  });

  test("a non-admin cannot manage a project merely shared with them", () => {
    expect(canManageProject("shared", false)).toBe(false);
  });

  test("the oversight role implies manage even before the permission resolves", () => {
    expect(canManageProject("admin", false)).toBe(true);
  });
});
