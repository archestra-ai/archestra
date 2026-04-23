import { describe, expect, test } from "vitest";
import { normalizeMemoryRequesterRole } from "./requester-role";

describe("normalizeMemoryRequesterRole", () => {
  test("maps aliases to team-admin", () => {
    expect(normalizeMemoryRequesterRole("team-admin")).toBe("team-admin");
    expect(normalizeMemoryRequesterRole("team_admin")).toBe("team-admin");
    expect(normalizeMemoryRequesterRole("team admin")).toBe("team-admin");
    expect(normalizeMemoryRequesterRole("editor")).toBe("team-admin");
  });

  test("normalizes case and whitespace", () => {
    expect(normalizeMemoryRequesterRole("  ADMIN  ")).toBe("admin");
    expect(normalizeMemoryRequesterRole("  Team_Admin ")).toBe("team-admin");
  });

  test("falls back to member", () => {
    expect(normalizeMemoryRequesterRole("unknown")).toBe("member");
    expect(normalizeMemoryRequesterRole("")).toBe("member");
    expect(normalizeMemoryRequesterRole(null)).toBe("member");
    expect(normalizeMemoryRequesterRole(undefined)).toBe("member");
  });
});
