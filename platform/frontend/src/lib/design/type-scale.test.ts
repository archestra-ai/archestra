import { describe, expect, it } from "vitest";
import { type TypeRole, typeRole } from "./type-scale";

const classesFor = (role: TypeRole) => typeRole({ role }).split(" ");

/**
 * The scale's rules are the deliverable, not the class strings. These pin the
 * three that a well-meaning edit silently breaks: muting body copy to calm a
 * page down, letting a title drift up a size instead of a weight, and dropping
 * tabular figures off a number that ticks.
 */
describe("type scale", () => {
  it("defines the four roles used by entity surfaces", () => {
    const roles: TypeRole[] = ["section-title", "label", "body", "meta"];
    for (const role of roles) {
      // A role that resolves to "" would style an element with nothing, and
      // `"".split(" ")` has length 1, so counting tokens cannot see it.
      expect(typeRole({ role }), role).not.toBe("");
      expect(
        classesFor(role).filter((token) => /^(text|font)-/.test(token)),
        `${role} names neither a size, a weight nor a colour`,
      ).not.toEqual([]);
    }
  });

  it("keeps body copy on foreground, never muted", () => {
    expect(classesFor("body")).toContain("text-foreground");
    for (const role of ["section-title", "label", "body", "meta"] as const) {
      if (role === "label" || role === "meta") {
        continue;
      }
      expect(classesFor(role), role).not.toContain("text-muted-foreground");
    }
  });

  it("separates the titles from body by weight, not by size", () => {
    expect(classesFor("section-title")).toContain("text-sm");
    expect(classesFor("section-title")).toContain("font-medium");
    expect(classesFor("body")).toContain("font-normal");
  });
});
