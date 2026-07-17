// BetterAuth apiKey-plugin defaults (@better-auth/api-key). Not set explicitly
// in better-auth.ts, so these mirror the library contract the create call must satisfy.
export const MAX_EXPIRY_DAYS = 365;
export const MAX_KEY_NAME_LENGTH = 32;
// Min is 1 day + a 60s buffer so a slow submit can't send an expiresIn under 86400s.
export const MIN_EXPIRY_MS = 24 * 60 * 60 * 1000 + 60 * 1000;

const MAX_EXPIRY_MS = MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

export function getExpiresAtError({
  expiresAt,
  now,
}: {
  expiresAt: Date | null;
  now: number;
}): string | null {
  if (!expiresAt) return null; // never expires — allowed
  const delta = expiresAt.getTime() - now;
  if (delta < MIN_EXPIRY_MS)
    return "Expiration must be at least 1 day from now";
  if (delta > MAX_EXPIRY_MS) return "Expiration can be at most 1 year from now";
  return null;
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
