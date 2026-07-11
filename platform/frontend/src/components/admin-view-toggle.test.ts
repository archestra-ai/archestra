import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");

vi.mock("next/navigation");

import {
  buildAdminViewToggleParams,
  isAdminViewEnabled,
} from "./admin-view-toggle";

describe("isAdminViewEnabled", () => {
  it("returns false when the param is absent", () => {
    expect(isAdminViewEnabled(new URLSearchParams(""))).toBe(false);
  });

  it("returns true only for the literal 'true'", () => {
    expect(isAdminViewEnabled(new URLSearchParams("adminView=true"))).toBe(
      true,
    );
  });

  it("returns false for 'false'", () => {
    expect(isAdminViewEnabled(new URLSearchParams("adminView=false"))).toBe(
      false,
    );
  });

  it("returns false for garbage values", () => {
    expect(isAdminViewEnabled(new URLSearchParams("adminView=1"))).toBe(false);
    expect(isAdminViewEnabled(new URLSearchParams("adminView=TRUE"))).toBe(
      false,
    );
    expect(isAdminViewEnabled(new URLSearchParams("adminView="))).toBe(false);
  });
});

describe("buildAdminViewToggleParams", () => {
  it("turning ON sets adminView=true and resets the page", () => {
    const params = buildAdminViewToggleParams(
      new URLSearchParams("scope=personal&page=3"),
      true,
    );
    expect(params.get("adminView")).toBe("true");
    expect(params.get("page")).toBe("1");
    expect(params.get("scope")).toBe("personal");
  });

  it("turning ON keeps existing narrowing filters", () => {
    const params = buildAdminViewToggleParams(
      new URLSearchParams("authorIds=u1,u2&teamIds=t1"),
      true,
    );
    expect(params.get("authorIds")).toBe("u1,u2");
    expect(params.get("teamIds")).toBe("t1");
  });

  it("turning OFF removes adminView and the stale narrowing filters", () => {
    const params = buildAdminViewToggleParams(
      new URLSearchParams(
        "adminView=true&authorIds=u1&excludeAuthorIds=u2&teamIds=t1&scope=team&page=5",
      ),
      false,
    );
    expect(params.get("adminView")).toBeNull();
    expect(params.get("authorIds")).toBeNull();
    expect(params.get("excludeAuthorIds")).toBeNull();
    expect(params.get("teamIds")).toBeNull();
    expect(params.get("scope")).toBe("team");
    expect(params.get("page")).toBe("1");
  });

  it("turning OFF is a no-op-safe cleanup when the params were never set", () => {
    const params = buildAdminViewToggleParams(new URLSearchParams(""), false);
    expect(params.get("adminView")).toBeNull();
    expect(params.get("page")).toBe("1");
  });

  it("does not mutate the input params", () => {
    const current = new URLSearchParams("adminView=true&authorIds=u1");
    buildAdminViewToggleParams(current, false);
    expect(current.get("adminView")).toBe("true");
    expect(current.get("authorIds")).toBe("u1");
  });
});
