import { describe, expect, test, vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    frontendBaseUrl: "https://archestra.example.com",
    auth: { secret: "test-signing-secret" },
    kb: {
      googleDriveOAuth: {
        clientId: "client-abc.apps.googleusercontent.com",
        clientSecret: "client-secret-xyz",
      },
    },
  }),
);

import {
  type GoogleDriveOAuthState,
  getGoogleDriveOAuthRedirectUri,
  isGoogleDriveOAuthConfigured,
  resolveGoogleDriveOAuthReturnTo,
  signGoogleDriveOAuthState,
  verifyGoogleDriveOAuthState,
} from "./gdrive-oauth";

const state: GoogleDriveOAuthState = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  returnTo: "https://archestra.example.com/knowledge/connectors/abc",
};

describe("google drive oauth state", () => {
  test("round-trips the connector, user, and organization it was issued for", () => {
    expect(
      verifyGoogleDriveOAuthState(signGoogleDriveOAuthState(state)),
    ).toEqual(state);
  });

  test("rejects a tampered payload", () => {
    // The callback trusts state for the connector it writes a credential to,
    // so an attacker-chosen connector id must not survive re-signing checks.
    const signed = signGoogleDriveOAuthState(state);
    const [encoded, signature] = signed.split(".");
    const forged = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf-8"),
    );
    forged.connectorId = "99999999-9999-4999-8999-999999999999";
    const reencoded = Buffer.from(JSON.stringify(forged)).toString("base64url");

    expect(verifyGoogleDriveOAuthState(`${reencoded}.${signature}`)).toBeNull();
  });

  test("rejects a state signed with a different secret", () => {
    const foreign = `${Buffer.from(JSON.stringify({ ...state, exp: Date.now() + 60_000 })).toString("base64url")}.not-our-signature`;
    expect(verifyGoogleDriveOAuthState(foreign)).toBeNull();
  });

  test("rejects an expired state", () => {
    const signed = signGoogleDriveOAuthState(state);
    // 15 minutes is the whole window; a link left open overnight is not one
    // the callback should still act on.
    vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
    try {
      expect(verifyGoogleDriveOAuthState(signed)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ["", "missing separator"],
    ["not-base64.signature", "unparseable payload"],
    [".signature-only", "empty payload"],
  ])("rejects a malformed state (%s)", (raw) => {
    expect(verifyGoogleDriveOAuthState(raw)).toBeNull();
  });

  test("two states for the same connector differ", () => {
    // A nonce per authorization, so a state cannot be recognized or replayed
    // by matching it against one seen earlier.
    expect(signGoogleDriveOAuthState(state)).not.toBe(
      signGoogleDriveOAuthState(state),
    );
  });
});

describe("return-to confinement", () => {
  test("keeps a same-origin destination", () => {
    expect(
      resolveGoogleDriveOAuthReturnTo(
        "https://archestra.example.com/knowledge/connectors/abc?tab=documents",
      ),
    ).toBe(
      "https://archestra.example.com/knowledge/connectors/abc?tab=documents",
    );
  });

  test.each([
    "https://evil.example.net/steal",
    "//evil.example.net",
    "javascript:alert(1)",
  ])("refuses to redirect off this deployment (%s)", (candidate) => {
    // The value survives a round trip through Google, so an unchecked one
    // would make the callback an open redirect.
    expect(resolveGoogleDriveOAuthReturnTo(candidate)).toBe(
      "https://archestra.example.com/knowledge",
    );
  });

  test("falls back when nothing was supplied", () => {
    expect(resolveGoogleDriveOAuthReturnTo(undefined)).toBe(
      "https://archestra.example.com/knowledge",
    );
  });
});

describe("deployment configuration", () => {
  test("builds the redirect URI on the origin the browser is on", () => {
    // Must match the Cloud Console registration exactly, and the frontend
    // proxies /api/* through to the backend.
    expect(getGoogleDriveOAuthRedirectUri()).toBe(
      "https://archestra.example.com/api/connectors/gdrive/oauth/callback",
    );
  });

  test("reports the mode as available when a client is configured", () => {
    expect(isGoogleDriveOAuthConfigured()).toBe(true);
  });
});
