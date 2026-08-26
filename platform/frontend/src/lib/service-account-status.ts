/**
 * Whether a service account, or one of its keys, can actually authenticate.
 *
 * The screens used to answer this with `disabled` alone, which is only one of
 * the three conditions the backend checks. `ServiceAccountModel.findByToken`
 * accepts a key when the account is enabled AND the key is enabled AND the key
 * has not expired, so an enabled account whose only key lapsed last week was
 * shown as "Active" beside "API keys: 1" while every call it made was
 * rejected. Both readings are derived here, from those same three conditions,
 * so the list badge, the detail header and the filters cannot drift from each
 * other or from what the gateway will accept.
 */

/**
 * A key expiring within this window is called out as expiring rather than
 * active, so a rotation gets a lead time instead of an outage. Two weeks is
 * roughly the shortest notice that survives someone being on holiday.
 */
export const EXPIRY_WARNING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A single API key, in severity order: the first that applies wins. */
export type KeyStatus = "disabled" | "expired" | "expiring" | "active";

/** A whole service account, in the same severity order. */
export type AccountHealth =
  | "disabled"
  | "no-keys"
  | "no-usable-keys"
  | "expiring"
  | "active";

/** The subset of a key this module reads, so callers can pass either shape. */
type KeyLike = {
  disabled: boolean;
  expiresAt: string | Date | null;
};

/** The subset of an account this module reads. */
type AccountLike = {
  disabled: boolean;
  tokenCount: number;
  activeTokenCount: number;
  soonestExpiryAt: string | Date | null;
};

export function getKeyStatus(key: KeyLike, now: Date = new Date()): KeyStatus {
  if (key.disabled) return "disabled";
  const expiresAt = toDate(key.expiresAt);
  if (!expiresAt) return "active";
  if (expiresAt.getTime() <= now.getTime()) return "expired";
  return isWithinWarningWindow(expiresAt, now) ? "expiring" : "active";
}

export function getAccountHealth(
  account: AccountLike,
  now: Date = new Date(),
): AccountHealth {
  if (account.disabled) return "disabled";
  if (account.tokenCount === 0) return "no-keys";
  // Has keys, none of which would authenticate: expired, disabled, or both.
  if (account.activeTokenCount === 0) return "no-usable-keys";
  const soonestExpiryAt = toDate(account.soonestExpiryAt);
  if (soonestExpiryAt && isWithinWarningWindow(soonestExpiryAt, now)) {
    return "expiring";
  }
  return "active";
}

/**
 * Whether the account can authenticate at all right now. `active` and
 * `expiring` both still work; the rest do not.
 */
export function canAuthenticate(health: AccountHealth): boolean {
  return health === "active" || health === "expiring";
}

export const ACCOUNT_HEALTH_LABELS: Record<AccountHealth, string> = {
  active: "Active",
  expiring: "Key expiring",
  "no-usable-keys": "No usable key",
  "no-keys": "No keys",
  disabled: "Disabled",
};

export const KEY_STATUS_LABELS: Record<KeyStatus, string> = {
  active: "Active",
  expiring: "Expiring",
  expired: "Expired",
  disabled: "Disabled",
};

/**
 * Why the account cannot be used, for a tooltip or an inline explanation.
 * Null for the two healthy readings, which need no excuse.
 */
export function describeAccountHealth(health: AccountHealth): string | null {
  switch (health) {
    case "disabled":
      return "This service account is disabled, so none of its keys can authenticate.";
    case "no-keys":
      return "This service account has no API keys, so it cannot authenticate. Create one to start using it.";
    case "no-usable-keys":
      return "Every key on this service account is expired or disabled, so it cannot authenticate.";
    default:
      return null;
  }
}

/** Whole days until `date`, rounded up, floored at 0. */
export function daysUntil(date: string | Date, now: Date = new Date()): number {
  const target = toDate(date);
  if (!target) return 0;
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / DAY_MS));
}

// === Internal helpers

function isWithinWarningWindow(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() - now.getTime() <= EXPIRY_WARNING_DAYS * DAY_MS;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
