/**
 * Authorization-server binding for operator-configured credentials (SEP-2352).
 *
 * Only configured credentials can go stale here: dynamically registered ones
 * are never persisted, so a fresh registration happens every flow. These pin
 * the case that can actually go wrong — a resource moving to a different
 * authorization server while a configured client id stays behind.
 */

import { describe, expect, test } from "@/test";
import {
  checkPreregisteredCredentialBinding,
  isClientIdMetadataDocument,
  sameAuthorizationServer,
} from "./oauth-issuer-binding";

const A = "https://auth-a.example.com";
const B = "https://auth-b.example.com";

describe("checkPreregisteredCredentialBinding", () => {
  test("credentials are used against the server they were configured for", () => {
    expect(
      checkPreregisteredCredentialBinding({
        configuredAuthServer: A,
        discoveredIssuer: A,
        clientId: "abc123",
      }),
    ).toEqual({ ok: true });
  });

  test("a resource that moved to another server is refused", () => {
    expect(
      checkPreregisteredCredentialBinding({
        configuredAuthServer: A,
        discoveredIssuer: B,
        clientId: "abc123",
      }),
    ).toEqual({ ok: false, reason: "preregistered_issuer_mismatch" });
  });

  test("a CIMD client id stays portable across servers", () => {
    expect(
      checkPreregisteredCredentialBinding({
        configuredAuthServer: A,
        discoveredIssuer: B,
        clientId: "https://client.example.com/metadata.json",
      }),
    ).toEqual({ ok: true });
  });

  test("missing configuration proceeds rather than failing closed", () => {
    // Nothing to compare against is not evidence of a mismatch, and failing
    // here would break every deployment that never set an auth server.
    expect(
      checkPreregisteredCredentialBinding({
        configuredAuthServer: undefined,
        discoveredIssuer: B,
        clientId: "abc123",
      }),
    ).toEqual({ ok: true });

    expect(
      checkPreregisteredCredentialBinding({
        configuredAuthServer: A,
        discoveredIssuer: undefined,
        clientId: "abc123",
      }),
    ).toEqual({ ok: true });
  });
});

describe("sameAuthorizationServer", () => {
  test("a trailing slash is tolerated", () => {
    // Unlike the RFC 9207 response check, this side is typed by an operator
    // into configuration, so a trailing slash is a typo rather than an attack.
    expect(sameAuthorizationServer(A, `${A}/`)).toBe(true);
  });

  test("a different host is not the same server", () => {
    expect(sameAuthorizationServer(A, B)).toBe(false);
  });
});

describe("isClientIdMetadataDocument", () => {
  test("https identifiers are portable, opaque ids and http are not", () => {
    expect(isClientIdMetadataDocument("https://c.example.com/x.json")).toBe(
      true,
    );
    expect(isClientIdMetadataDocument("abc123")).toBe(false);
    expect(isClientIdMetadataDocument("http://c.example.com/x.json")).toBe(
      false,
    );
  });
});
