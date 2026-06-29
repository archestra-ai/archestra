import { describe, expect, it } from "vitest";
import {
  getShownProviders,
  resolveEffectiveId,
  resolveInitialClientId,
  toMcpServerSlug,
} from "./connection-flow.utils";

const baseParams = {
  selected: null,
  fromUrl: null,
  adminDefault: null,
  systemDefault: null,
  firstAvailable: null,
  skipAdminDefault: false,
};

describe("resolveEffectiveId", () => {
  it("returns the user's selection first, ignoring everything else", () => {
    expect(
      resolveEffectiveId({
        ...baseParams,
        selected: "user-pick",
        fromUrl: "url-id",
        adminDefault: "admin-id",
        systemDefault: "system-id",
        firstAvailable: "first-id",
      }),
    ).toBe("user-pick");
  });

  it("falls back to the URL param when nothing is selected", () => {
    expect(
      resolveEffectiveId({
        ...baseParams,
        fromUrl: "url-id",
        adminDefault: "admin-id",
      }),
    ).toBe("url-id");
  });

  it("falls back to the admin default when selection and URL are empty", () => {
    expect(
      resolveEffectiveId({
        ...baseParams,
        adminDefault: "admin-id",
        systemDefault: "system-id",
      }),
    ).toBe("admin-id");
  });

  it("skips the admin default when skipAdminDefault is true", () => {
    expect(
      resolveEffectiveId({
        ...baseParams,
        adminDefault: "admin-id",
        systemDefault: "system-id",
        skipAdminDefault: true,
      }),
    ).toBe("system-id");
  });

  it("does not skip the URL param even when skipAdminDefault is true", () => {
    expect(
      resolveEffectiveId({
        ...baseParams,
        fromUrl: "url-id",
        adminDefault: "admin-id",
        skipAdminDefault: true,
      }),
    ).toBe("url-id");
  });

  it("falls through to systemDefault when adminDefault is null", () => {
    expect(
      resolveEffectiveId({ ...baseParams, systemDefault: "system-id" }),
    ).toBe("system-id");
  });

  it("falls through to firstAvailable when everything else is empty", () => {
    expect(
      resolveEffectiveId({ ...baseParams, firstAvailable: "first-id" }),
    ).toBe("first-id");
  });

  it("returns null when nothing is available", () => {
    expect(resolveEffectiveId(baseParams)).toBeNull();
  });

  it("treats undefined the same as null for optional slots", () => {
    expect(
      resolveEffectiveId({
        ...baseParams,
        adminDefault: undefined,
        systemDefault: undefined,
        firstAvailable: "first-id",
      }),
    ).toBe("first-id");
  });
});

describe("resolveInitialClientId", () => {
  const visibleClientIds = ["claude-code", "cursor", "generic"] as const;

  it("returns null when nothing else is specified", () => {
    expect(
      resolveInitialClientId({
        urlClientId: null,
        adminDefaultClientId: null,
        visibleClientIds,
      }),
    ).toBeNull();
  });

  it("picks the admin default when no URL param is set", () => {
    expect(
      resolveInitialClientId({
        urlClientId: null,
        adminDefaultClientId: "cursor",
        visibleClientIds,
      }),
    ).toBe("cursor");
  });

  it("lets the URL param override the admin default", () => {
    expect(
      resolveInitialClientId({
        urlClientId: "claude-code",
        adminDefaultClientId: "cursor",
        visibleClientIds,
      }),
    ).toBe("claude-code");
  });

  it("ignores a URL param that isn't a visible client", () => {
    expect(
      resolveInitialClientId({
        urlClientId: "unknown-client",
        adminDefaultClientId: "cursor",
        visibleClientIds,
      }),
    ).toBe("cursor");
  });

  it("returns null when the admin default isn't visible", () => {
    expect(
      resolveInitialClientId({
        urlClientId: null,
        adminDefaultClientId: "hidden-client",
        visibleClientIds,
      }),
    ).toBeNull();
  });
});

describe("getShownProviders", () => {
  it("returns null when organization is undefined", () => {
    expect(getShownProviders(undefined)).toBeNull();
  });

  it("returns null when the field is null (show all)", () => {
    expect(getShownProviders({ connectionShownProviders: null })).toBeNull();
  });

  it("returns known providers unchanged", () => {
    expect(
      getShownProviders({
        connectionShownProviders: ["openai", "anthropic"],
      }),
    ).toEqual(["openai", "anthropic"]);
  });

  it("drops unknown provider IDs silently", () => {
    expect(
      getShownProviders({
        connectionShownProviders: ["openai", "not-a-provider", "anthropic"],
      }),
    ).toEqual(["openai", "anthropic"]);
  });
});

describe("toMcpServerSlug", () => {
  it("lowercases a single-word name", () => {
    expect(toMcpServerSlug("Archestra")).toBe("archestra");
  });

  it("dash-separates multi-word names", () => {
    expect(toMcpServerSlug("Acme AI")).toBe("acme-ai");
  });

  it("collapses runs of non-alphanumerics into a single dash", () => {
    expect(toMcpServerSlug("Foo !! Bar__Baz")).toBe("foo-bar-baz");
  });

  it("trims leading and trailing dashes", () => {
    expect(toMcpServerSlug("  !Foo!  ")).toBe("foo");
  });

  it("falls back to 'archestra' when the input has no alphanumerics", () => {
    expect(toMcpServerSlug("!!!")).toBe("archestra");
    expect(toMcpServerSlug("")).toBe("archestra");
  });
});
