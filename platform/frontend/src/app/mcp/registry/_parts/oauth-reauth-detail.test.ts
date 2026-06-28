import { describe, expect, it } from "vitest";
import { formatOAuthFailureDetail } from "./oauth-reauth-detail";

describe("formatOAuthFailureDetail", () => {
  it("combines the sanitized error code with the failure time", () => {
    const detail = formatOAuthFailureDetail(
      "invalid_grant",
      "2026-06-25T20:36:12.000Z",
    );
    expect(detail).toMatch(/^invalid_grant · failed /);
  });

  it("falls back to a generic reason for a null or empty error code", () => {
    expect(formatOAuthFailureDetail(null, null)).toBe("authentication expired");
    // An empty code must not render a bare "· failed …" with no reason.
    expect(formatOAuthFailureDetail("", "2026-06-25T20:36:12.000Z")).toMatch(
      /^authentication expired · failed /,
    );
  });

  it("drops the timestamp clause when the date is unparseable", () => {
    expect(formatOAuthFailureDetail("invalid_grant", "not-a-date")).toBe(
      "invalid_grant",
    );
  });

  it("shows only the reason when no failure time is given", () => {
    expect(formatOAuthFailureDetail("invalid_grant", null)).toBe(
      "invalid_grant",
    );
  });
});
