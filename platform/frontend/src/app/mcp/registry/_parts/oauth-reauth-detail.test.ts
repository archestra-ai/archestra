import { describe, expect, it } from "vitest";
import {
  formatOAuthFailureDetail,
  humanizeOAuthErrorCode,
} from "./oauth-reauth-detail";

describe("humanizeOAuthErrorCode", () => {
  it.each([
    ["invalid_request", "The refresh request was malformed"],
    ["invalid_client", "The stored client credentials are no longer valid"],
    [
      "invalid_grant",
      "The refresh token is invalid, expired, or has been revoked",
    ],
    [
      "unauthorized_client",
      "This connection isn't authorized for token refresh",
    ],
    [
      "unsupported_grant_type",
      "The authorization server no longer supports refreshing this connection",
    ],
    ["invalid_scope", "The originally granted permissions are no longer valid"],
    ["refresh_failed", "The connection could not be refreshed"],
    ["no_refresh_token", "No refresh token is available for this connection"],
  ])("maps %s to its human-readable name", (code, expected) => {
    expect(humanizeOAuthErrorCode(code)).toBe(expected);
  });

  it("falls back to the raw code for an unrecognized/vendor-specific code", () => {
    expect(humanizeOAuthErrorCode("invalid_target")).toBe("invalid_target");
  });

  it("falls back to the raw code for an empty string", () => {
    expect(humanizeOAuthErrorCode("")).toBe("");
  });
});

describe("formatOAuthFailureDetail", () => {
  it("combines the humanized error code with the failure time", () => {
    const detail = formatOAuthFailureDetail(
      "invalid_grant",
      "2026-06-25T20:36:12.000Z",
    );
    expect(detail).toMatch(
      /^The refresh token is invalid, expired, or has been revoked · failed /,
    );
  });

  it("shows the raw code for an unrecognized error code", () => {
    const detail = formatOAuthFailureDetail(
      "invalid_target",
      "2026-06-25T20:36:12.000Z",
    );
    expect(detail).toMatch(/^invalid_target · failed /);
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
      "The refresh token is invalid, expired, or has been revoked",
    );
  });

  it("shows only the reason when no failure time is given", () => {
    expect(formatOAuthFailureDetail("invalid_grant", null)).toBe(
      "The refresh token is invalid, expired, or has been revoked",
    );
  });
});
