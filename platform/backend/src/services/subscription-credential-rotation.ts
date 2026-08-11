/**
 * Persist-side companion to the subscription token managers' ID-less
 * validation path.
 *
 * Validating a subscription credential (ChatGPT/Codex, X Premium) redeems its
 * refresh token, and the issuer may ROTATE it — invalidating the token that was
 * just submitted. At key creation/reconnect there is no row yet (or the row's
 * stored secret is about to be replaced), so the managers stash the rotation
 * in memory instead of persisting it. Routes call this helper after validation
 * to re-encode the credential with the newest token before writing the secret;
 * without it, the stored credential would be dead on arrival and every use
 * would demand a reconnect.
 */

import { subscriptionKindFromCredential } from "@archestra/shared";
import {
  decodeOpenAiCodexCredential,
  encodeOpenAiCodexCredential,
} from "./openai-codex-credentials";
import { openAiCodexTokenManager } from "./openai-codex-token";
import {
  decodeXaiSubscriptionCredential,
  encodeXaiSubscriptionCredential,
} from "./xai-subscription-credentials";
import { xaiSubscriptionTokenManager } from "./xai-subscription-token";

/**
 * Re-encodes a subscription credential with the newest refresh token this
 * process observed for it during validation. Returns the value unchanged for
 * non-subscription credentials or when no rotation was observed.
 */
export function withLatestRotatedRefreshToken(value: string): string {
  const kind = subscriptionKindFromCredential(value);
  if (kind === "chatgpt") {
    const credential = decodeOpenAiCodexCredential(value);
    if (!credential) {
      return value;
    }
    const latest = openAiCodexTokenManager.latestKnownRefreshToken(
      credential.refreshToken,
    );
    return latest === credential.refreshToken
      ? value
      : encodeOpenAiCodexCredential({ ...credential, refreshToken: latest });
  }
  if (kind === "x-premium") {
    const credential = decodeXaiSubscriptionCredential(value);
    if (!credential) {
      return value;
    }
    const latest = xaiSubscriptionTokenManager.latestKnownRefreshToken(
      credential.refreshToken,
    );
    return latest === credential.refreshToken
      ? value
      : encodeXaiSubscriptionCredential({
          ...credential,
          refreshToken: latest,
        });
  }
  return value;
}
