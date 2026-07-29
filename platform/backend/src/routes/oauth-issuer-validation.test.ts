/**
 * RFC 9207 issuer validation.
 *
 * This is a mix-up-attack mitigation, so the cases that matter are the ones
 * where a response from one authorization server is presented against another's
 * recorded issuer. The normalization tests exist because every normalization the
 * spec forbids would widen what counts as a match, and a wider match is exactly
 * what the attack needs.
 */

import { describe, expect, test } from "@/test";
import {
  isAuthorizationErrorResponse,
  validateAuthorizationResponseIssuer,
} from "./oauth-issuer-validation";

const ISSUER = "https://auth.example.com";

describe("validateAuthorizationResponseIssuer", () => {
  test("a matching issuer proceeds", () => {
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: ISSUER,
        recordedIssuer: ISSUER,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: true });
  });

  test("a response from a different authorization server is rejected", () => {
    // The mix-up attack itself.
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: "https://evil.example.com",
        recordedIssuer: ISSUER,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });
  });

  test("a server that advertised iss but omitted it is rejected", () => {
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: undefined,
        recordedIssuer: ISSUER,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: false, reason: "issuer_missing" });
  });

  test("a server that never advertised iss and omitted it proceeds", () => {
    // Rejection on absence stays keyed to the advertisement, so servers that
    // predate RFC 9207 keep working.
    for (const supported of [false, null, undefined]) {
      expect(
        validateAuthorizationResponseIssuer({
          responseIssuer: undefined,
          recordedIssuer: ISSUER,
          issParameterSupported: supported,
        }),
      ).toEqual({ ok: true });
    }
  });

  test("a present iss is compared even when the server never advertised it", () => {
    // The spec's local-policy row: servers emitting iss before updating their
    // metadata still get the protection.
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: "https://evil.example.com",
        recordedIssuer: ISSUER,
        issParameterSupported: false,
      }),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });

    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: ISSUER,
        recordedIssuer: ISSUER,
        issParameterSupported: false,
      }),
    ).toEqual({ ok: true });
  });

  test("a present iss with nothing recorded cannot be verified, so is rejected", () => {
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: ISSUER,
        recordedIssuer: null,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });
  });

  test("an empty iss counts as absent rather than as a match", () => {
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer: "",
        recordedIssuer: ISSUER,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: false, reason: "issuer_missing" });
  });
});

describe("comparison is exact", () => {
  // Each of these is a normalization RFC 3986 Section 6.2.2-6.2.3 would permit
  // and the spec explicitly forbids. Accepting any of them would let a
  // near-miss issuer pass.
  test.each([
    ["host case folding", "https://AUTH.example.com"],
    ["scheme case folding", "HTTPS://auth.example.com"],
    ["trailing slash", "https://auth.example.com/"],
    ["default port elision", "https://auth.example.com:443"],
    ["percent-encoding", "https://auth.example%2Ecom"],
  ])("%s does not count as a match", (_label, responseIssuer) => {
    expect(
      validateAuthorizationResponseIssuer({
        responseIssuer,
        recordedIssuer: ISSUER,
        issParameterSupported: true,
      }),
    ).toEqual({ ok: false, reason: "issuer_mismatch" });
  });
});

describe("isAuthorizationErrorResponse", () => {
  test("recognises an error response", () => {
    expect(isAuthorizationErrorResponse({ error: "access_denied" })).toBe(true);
  });

  test("a successful response is not an error response", () => {
    expect(isAuthorizationErrorResponse({})).toBe(false);
    expect(isAuthorizationErrorResponse({ error: "" })).toBe(false);
    expect(isAuthorizationErrorResponse({ error: null })).toBe(false);
  });
});
