import { describe, expect, it } from "vitest";
import {
  canAuthenticate,
  daysUntil,
  EXPIRY_WARNING_DAYS,
  getAccountHealth,
  getKeyStatus,
} from "./service-account-status";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

describe("getKeyStatus", () => {
  it("reports a key with no expiry as active", () => {
    expect(getKeyStatus({ disabled: false, expiresAt: null }, NOW)).toBe(
      "active",
    );
  });

  it("reports a key expiring beyond the warning window as active", () => {
    const expiresAt = daysFromNow(EXPIRY_WARNING_DAYS + 1);
    expect(getKeyStatus({ disabled: false, expiresAt }, NOW)).toBe("active");
  });

  it("reports a key expiring inside the warning window as expiring", () => {
    const expiresAt = daysFromNow(EXPIRY_WARNING_DAYS - 1);
    expect(getKeyStatus({ disabled: false, expiresAt }, NOW)).toBe("expiring");
  });

  it("reports a key past its expiry as expired", () => {
    expect(
      getKeyStatus({ disabled: false, expiresAt: daysFromNow(-1) }, NOW),
    ).toBe("expired");
  });

  it("treats expiry exactly at now as expired, matching the backend's strict >", () => {
    // `findByToken` accepts only `expiresAt > now`, so a key expiring this
    // instant is already rejected and must not read as merely expiring.
    expect(getKeyStatus({ disabled: false, expiresAt: NOW }, NOW)).toBe(
      "expired",
    );
  });

  it("prefers disabled over expired, so the deliberate reason is the one shown", () => {
    expect(
      getKeyStatus({ disabled: true, expiresAt: daysFromNow(-5) }, NOW),
    ).toBe("disabled");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(
      getKeyStatus(
        { disabled: false, expiresAt: daysFromNow(-1).toISOString() },
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("getAccountHealth", () => {
  const healthy = {
    disabled: false,
    tokenCount: 2,
    activeTokenCount: 2,
    soonestExpiryAt: null,
  };

  it("reports a working account as active", () => {
    expect(getAccountHealth(healthy, NOW)).toBe("active");
  });

  it("reports a disabled account as disabled even when its keys are fine", () => {
    expect(getAccountHealth({ ...healthy, disabled: true }, NOW)).toBe(
      "disabled",
    );
  });

  it("distinguishes an account that never had keys from one whose keys stopped working", () => {
    expect(
      getAccountHealth({ ...healthy, tokenCount: 0, activeTokenCount: 0 }, NOW),
    ).toBe("no-keys");
    expect(getAccountHealth({ ...healthy, activeTokenCount: 0 }, NOW)).toBe(
      "no-usable-keys",
    );
  });

  it("reports an account whose soonest key expiry is near as expiring", () => {
    expect(
      getAccountHealth(
        { ...healthy, soonestExpiryAt: daysFromNow(EXPIRY_WARNING_DAYS - 1) },
        NOW,
      ),
    ).toBe("expiring");
  });

  it("does not warn when the soonest expiry is beyond the window", () => {
    expect(
      getAccountHealth(
        { ...healthy, soonestExpiryAt: daysFromNow(EXPIRY_WARNING_DAYS + 1) },
        NOW,
      ),
    ).toBe("active");
  });

  it("is the regression this module exists for: enabled, one key, expired", () => {
    // The old UI derived its badge from `disabled` alone and so called this
    // account "Active" while every request it made was rejected.
    const health = getAccountHealth(
      {
        disabled: false,
        tokenCount: 1,
        activeTokenCount: 0,
        soonestExpiryAt: null,
      },
      NOW,
    );
    expect(health).toBe("no-usable-keys");
    expect(canAuthenticate(health)).toBe(false);
  });
});

describe("canAuthenticate", () => {
  it("is true only for the two readings whose keys still pass authentication", () => {
    expect(canAuthenticate("active")).toBe(true);
    expect(canAuthenticate("expiring")).toBe(true);
    expect(canAuthenticate("no-keys")).toBe(false);
    expect(canAuthenticate("no-usable-keys")).toBe(false);
    expect(canAuthenticate("disabled")).toBe(false);
  });
});

describe("daysUntil", () => {
  it("rounds a partial day up, so 'in 1 day' never reads as 'in 0 days'", () => {
    expect(daysUntil(new Date(NOW.getTime() + 90_000_000), NOW)).toBe(2);
    expect(daysUntil(daysFromNow(3), NOW)).toBe(3);
  });

  it("floors a past date at zero rather than going negative", () => {
    expect(daysUntil(daysFromNow(-5), NOW)).toBe(0);
  });
});
