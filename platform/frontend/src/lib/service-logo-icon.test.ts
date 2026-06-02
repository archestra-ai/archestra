import { describe, expect, test } from "vitest";
import { getServiceLogoIconSrc } from "./service-logo-icon";

describe("getServiceLogoIconSrc", () => {
  test("resolves supported service logo icon references", () => {
    const src = getServiceLogoIconSrc("logo:playwright");

    expect(src).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(src ?? "")).toContain('fill="#2EAD33"');
  });

  test("ignores unsupported icon values", () => {
    expect(getServiceLogoIconSrc(null)).toBeNull();
    expect(getServiceLogoIconSrc("🤖")).toBeNull();
    expect(getServiceLogoIconSrc("logo:unknown")).toBeNull();
  });
});
