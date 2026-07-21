import {
  API_KEY_MAX_EXPIRATION_DAYS,
  API_KEY_MIN_EXPIRATION_DAYS,
} from "@archestra/shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Better Auth rejects API key expirations under 1 day or over 365 days out.
 * Returns a user-facing error for an invalid expiration, or null when valid.
 */
export function getApiKeyExpirationError(
  expiresAt: Date | null,
  now: Date = new Date(),
): string | null {
  if (!expiresAt) {
    return null;
  }

  const msFromNow = expiresAt.getTime() - now.getTime();
  if (msFromNow < API_KEY_MIN_EXPIRATION_DAYS * MS_PER_DAY) {
    return `Expiration must be at least ${API_KEY_MIN_EXPIRATION_DAYS} day from now.`;
  }
  if (msFromNow > API_KEY_MAX_EXPIRATION_DAYS * MS_PER_DAY) {
    return `Expiration cannot be more than ${API_KEY_MAX_EXPIRATION_DAYS} days from now.`;
  }

  return null;
}

/**
 * Disables calendar days that cannot contain any valid expiration time:
 * days that end before the minimum expiration and days that start after
 * the maximum.
 */
export function isApiKeyExpirationDateDisabled(
  date: Date,
  now: Date = new Date(),
): boolean {
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  if (
    endOfDay.getTime() - now.getTime() <
    API_KEY_MIN_EXPIRATION_DAYS * MS_PER_DAY
  ) {
    return true;
  }

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  return (
    startOfDay.getTime() - now.getTime() >
    API_KEY_MAX_EXPIRATION_DAYS * MS_PER_DAY
  );
}

export function shouldSkipCreateApiKeySubmit(params: {
  hasSubmittedForCurrentDialogOpen: boolean;
  isCreatePending: boolean;
  createdApiKeyValue: string | null;
}): boolean {
  return (
    params.hasSubmittedForCurrentDialogOpen ||
    params.isCreatePending ||
    !!params.createdApiKeyValue
  );
}
