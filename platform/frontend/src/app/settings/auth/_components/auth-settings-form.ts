import {
  DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";

/**
 * Shared form model for the auth settings page: both lifetime sections and
 * the page-level switch/role fields register into this single form so one
 * floating save bar can PATCH auth settings in a single request.
 */
export type AuthSettingsFormValues = {
  oauthLifetimePreset: string;
  oauthCustomLifetimeSeconds: number;
  sessionLifetimePreset: string;
  sessionCustomLifetimeSeconds: number;
  requireTwoFactor: boolean;
  defaultMemberRole: string;
};

export const CUSTOM_LIFETIME_VALUE = "custom";
export const NO_SESSION_LIMIT_VALUE = "none";

export const OAUTH_LIFETIME_PRESETS = [
  { label: "1 hour", value: 3_600 },
  { label: "7 days", value: 604_800 },
  { label: "30 days", value: 2_592_000 },
  { label: "1 year", value: DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS },
] as const;

export const SESSION_LIFETIME_PRESETS = [
  { label: "8 hours", value: 28_800 },
  { label: "24 hours", value: 86_400 },
  { label: "7 days", value: 604_800 },
  { label: "30 days", value: 2_592_000 },
] as const;

/** Fallback shown in the custom session input before a custom value is set. */
const DEFAULT_SESSION_CUSTOM_LIFETIME_SECONDS = 604_800;

type AuthSettingsSource = {
  oauthAccessTokenLifetimeSeconds?: number | null;
  sessionMaxAgeSeconds?: number | null;
  requireTwoFactor?: boolean | null;
  defaultMemberRole?: string | null;
};

export function getServerOauthLifetimeSeconds(
  organization: AuthSettingsSource | null | undefined,
): number {
  return (
    organization?.oauthAccessTokenLifetimeSeconds ??
    DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS
  );
}

export function getOauthPresetSelectValue(lifetimeSeconds: number): string {
  const preset = OAUTH_LIFETIME_PRESETS.find(
    (option) => option.value === lifetimeSeconds,
  );
  return preset ? String(preset.value) : CUSTOM_LIFETIME_VALUE;
}

export function getSelectedOauthLifetimeSeconds(values: {
  oauthLifetimePreset: string;
  oauthCustomLifetimeSeconds: number;
}): number {
  if (values.oauthLifetimePreset === CUSTOM_LIFETIME_VALUE) {
    return (
      values.oauthCustomLifetimeSeconds ??
      DEFAULT_OAUTH_ACCESS_TOKEN_LIFETIME_SECONDS
    );
  }

  return Number(values.oauthLifetimePreset);
}

function getSessionPresetSelectValue(lifetimeSeconds: number | null): string {
  if (lifetimeSeconds === null) {
    return NO_SESSION_LIMIT_VALUE;
  }
  const preset = SESSION_LIFETIME_PRESETS.find(
    (option) => option.value === lifetimeSeconds,
  );
  return preset ? String(preset.value) : CUSTOM_LIFETIME_VALUE;
}

export function getSelectedSessionLifetimeSeconds(values: {
  sessionLifetimePreset: string;
  sessionCustomLifetimeSeconds: number;
}): number | null {
  if (values.sessionLifetimePreset === NO_SESSION_LIMIT_VALUE) {
    return null;
  }
  if (values.sessionLifetimePreset === CUSTOM_LIFETIME_VALUE) {
    return values.sessionCustomLifetimeSeconds;
  }
  return Number(values.sessionLifetimePreset);
}

/**
 * Build the full form snapshot from the organization. Used for the initial
 * defaults (organization may still be loading, keeping the OAuth select
 * empty) and for every reset after load, save, or cancel.
 */
export function buildAuthSettingsFormValues(
  organization: AuthSettingsSource | null | undefined,
): AuthSettingsFormValues {
  const oauthLifetimeSeconds = getServerOauthLifetimeSeconds(organization);
  const sessionMaxAgeSeconds = organization?.sessionMaxAgeSeconds ?? null;
  return {
    oauthLifetimePreset: organization
      ? getOauthPresetSelectValue(oauthLifetimeSeconds)
      : "",
    oauthCustomLifetimeSeconds: oauthLifetimeSeconds,
    sessionLifetimePreset: getSessionPresetSelectValue(sessionMaxAgeSeconds),
    sessionCustomLifetimeSeconds:
      sessionMaxAgeSeconds ?? DEFAULT_SESSION_CUSTOM_LIFETIME_SECONDS,
    requireTwoFactor: organization?.requireTwoFactor ?? false,
    // Null column means "fall back to member", so surface member as selected.
    defaultMemberRole: organization?.defaultMemberRole ?? MEMBER_ROLE_NAME,
  };
}
