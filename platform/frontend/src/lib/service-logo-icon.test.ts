import { describe, expect, test } from "vitest";
import { getServiceLogoIconSrc } from "./service-logo-icon";

describe("getServiceLogoIconSrc", () => {
  test("resolves supported service logo icon references", () => {
    expect(getServiceLogoIconSrc("logo:playwright")).toBe(
      "/icons/simple-icons-microsoft/playwright.svg",
    );
  });

  test("ignores unsupported icon values", () => {
    expect(getServiceLogoIconSrc(null)).toBeNull();
    expect(getServiceLogoIconSrc("🤖")).toBeNull();
    expect(getServiceLogoIconSrc("logo:unknown")).toBeNull();
  });
});
