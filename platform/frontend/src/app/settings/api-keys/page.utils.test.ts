import { ARCHESTRA_TOKEN_PREFIX } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { getExpiresAtError, shouldSkipCreateApiKeySubmit } from "./page.utils";

describe("getExpiresAtError", () => {
  const now = Date.UTC(2026, 6, 17); // fixed reference instant
  const dayMs = 24 * 60 * 60 * 1000;

  it("allows a null expiration (never expires)", () => {
    expect(getExpiresAtError({ expiresAt: null, now })).toBeNull();
  });

  it("rejects an expiration under 1 day from now", () => {
    const expiresAt = new Date(now + 12 * 60 * 60 * 1000);
    expect(getExpiresAtError({ expiresAt, now })).toBe(
      "Expiration must be at least 1 day from now",
    );
  });

  it("rejects an expiration over 1 year from now", () => {
    const expiresAt = new Date(now + 366 * dayMs);
    expect(getExpiresAtError({ expiresAt, now })).toBe(
      "Expiration can be at most 1 year from now",
    );
  });

  it("allows a valid mid-range expiration", () => {
    const expiresAt = new Date(now + 30 * dayMs);
    expect(getExpiresAtError({ expiresAt, now })).toBeNull();
  });
});

describe("shouldSkipCreateApiKeySubmit", () => {
  it("allows submission for a fresh dialog state", () => {
    expect(
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: false,
        isCreatePending: false,
        createdApiKeyValue: null,
      }),
    ).toBe(false);
  });

  it("blocks submission when a create is already in flight", () => {
    expect(
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: false,
        isCreatePending: true,
        createdApiKeyValue: null,
      }),
    ).toBe(true);
  });

  it("blocks submission after the dialog has already created a key", () => {
    expect(
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: true,
        isCreatePending: false,
        createdApiKeyValue: `${ARCHESTRA_TOKEN_PREFIX}123`,
      }),
    ).toBe(true);
  });
});
