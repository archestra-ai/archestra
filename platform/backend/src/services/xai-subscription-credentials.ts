/**
 * xAI "X Premium (SuperGrok)" subscription credential encoding.
 *
 * This is an alternate auth mode on the existing `xai` provider: instead of a
 * static console API key, the stored credential is the OAuth material minted by
 * the X Premium device-code login (the same subscription third-party Grok CLIs
 * reuse).
 *
 * Following the ChatGPT/Codex precedent (services/openai-codex-credentials), the
 * credential is encoded into the single `apiKey` string that flows through the
 * chat → proxy → provider pipeline, behind a marker prefix. The wire shape stays
 * one string; only subscription-aware call sites (the xai adapter, the xai model
 * fetcher, this provider's token manager) decode it. That keeps the DB schema and
 * the whole credential-resolution path unchanged.
 *
 * The encoded payload is just the long-lived `refresh_token`. Unlike Codex there
 * is no account identifier to carry: xAI infers the account from the bearer and
 * requires no companion header. Short-lived access tokens are redeemed from the
 * refresh token at request time — see services/xai-subscription-token.
 */

import { SUBSCRIPTION_CREDENTIALS } from "@archestra/shared";

/**
 * Marker prefix identifying an encoded X Premium credential. Read from the
 * shared subscription registry so the encoding here and the per-user scoping
 * rules that key off the same prefix cannot drift apart.
 */
const XAI_SUBSCRIPTION_CREDENTIAL_MARKER =
  SUBSCRIPTION_CREDENTIALS["x-premium"].marker;

export interface XaiSubscriptionCredential {
  /** Long-lived xAI OAuth refresh token (may rotate on redemption). */
  refreshToken: string;
}

/** True when a resolved credential string is an X Premium credential. */
export function isXaiSubscriptionCredential(
  value: string | undefined,
): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(XAI_SUBSCRIPTION_CREDENTIAL_MARKER)
  );
}

export function encodeXaiSubscriptionCredential(
  credential: XaiSubscriptionCredential,
): string {
  // Fail loudly at encode time rather than minting a valid-looking string that
  // only breaks later at request time (decode rejects the same empty value).
  if (!credential.refreshToken) {
    throw new Error(
      "Cannot encode X Premium credential with an empty refreshToken",
    );
  }
  const json = JSON.stringify(credential);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `${XAI_SUBSCRIPTION_CREDENTIAL_MARKER}${b64}`;
}

export function decodeXaiSubscriptionCredential(
  value: string | undefined,
): XaiSubscriptionCredential | null {
  if (!isXaiSubscriptionCredential(value)) {
    return null;
  }
  try {
    const b64 = (value as string).slice(
      XAI_SUBSCRIPTION_CREDENTIAL_MARKER.length,
    );
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<XaiSubscriptionCredential>;
    if (!parsed.refreshToken) {
      return null;
    }
    return { refreshToken: parsed.refreshToken };
  } catch {
    return null;
  }
}
