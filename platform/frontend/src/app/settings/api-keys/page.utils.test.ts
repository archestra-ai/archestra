import { ARCHESTRA_TOKEN_PREFIX } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  getApiKeyExpirationError,
  isApiKeyExpirationDateDisabled,
  shouldSkipCreateApiKeySubmit,
} from "./page.utils";

const NOW = new Date("2026-07-18T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("getApiKeyExpirationError", () => {
  it("allows no expiration", () => {
    expect(getApiKeyExpirationError(null, NOW)).toBeNull();
  });

  it("rejects an expiration under 1 day from now", () => {
    expect(
      getApiKeyExpirationError(new Date(NOW.getTime() + 3 * HOUR_MS), NOW),
    ).toMatch(/at least 1 day/);
  });

  it("rejects an expiration more than 365 days from now", () => {
    expect(
      getApiKeyExpirationError(new Date(NOW.getTime() + 366 * DAY_MS), NOW),
    ).toMatch(/more than 365 days/);
  });

  it("allows an expiration within the valid range", () => {
    expect(
      getApiKeyExpirationError(new Date(NOW.getTime() + 30 * DAY_MS), NOW),
    ).toBeNull();
  });
});

describe("isApiKeyExpirationDateDisabled", () => {
  it("disables today when no time today is at least 1 day out", () => {
    expect(isApiKeyExpirationDateDisabled(new Date(NOW), NOW)).toBe(true);
  });

  it("keeps tomorrow enabled because late times are valid", () => {
    expect(
      isApiKeyExpirationDateDisabled(new Date(NOW.getTime() + DAY_MS), NOW),
    ).toBe(false);
  });

  it("disables days past the 365 day maximum", () => {
    expect(
      isApiKeyExpirationDateDisabled(
        new Date(NOW.getTime() + 367 * DAY_MS),
        NOW,
      ),
    ).toBe(true);
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
