import { describe, expect, it } from "vitest";
import { projectVisibilityToScope } from "./project-visibility";

describe("projectVisibilityToScope", () => {
  it("treats null visibility as a personal scope", () => {
    expect(projectVisibilityToScope(null)).toBe("personal");
  });

  it("maps organization visibility to the org scope", () => {
    expect(projectVisibilityToScope("organization")).toBe("org");
  });

  it("maps team visibility to the team scope", () => {
    expect(projectVisibilityToScope("team")).toBe("team");
  });
});
