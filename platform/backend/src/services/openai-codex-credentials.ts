/**
 * OpenAI "ChatGPT subscription" (Codex) credential encoding + constants.
 *
 * This is an alternate auth mode on the existing `openai` provider: instead of
 * a static `sk-…` API key, the stored credential is the OAuth material minted by
 * the ChatGPT/Codex login flow (the same subscription the `codex` CLI reuses).
 *
 * Following the Bedrock SigV4 precedent (clients/bedrock-credentials.ts), the
 * credential is encoded into the single `apiKey` string that flows through the
 * chat → proxy → provider pipeline, behind a marker prefix. The wire shape stays
 * one string; only Codex-aware call sites (the openai adapter, the openai model
 * fetcher, this provider's token manager) decode it. That keeps the DB schema and
 * the whole credential-resolution path unchanged.
 *
 * The encoded payload is the long-lived `refresh_token` plus the ChatGPT
 * `account_id` (needed for the `chatgpt-account-id` request header). Short-lived
 * access tokens are redeemed from the refresh token at request time — see
 * services/openai-codex-token.
 */

import {
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";

/** Marker prefix identifying an encoded ChatGPT-subscription credential. */
const OPENAI_CODEX_CREDENTIAL_MARKER = "chatgpt-oauth:";

export interface OpenAiCodexCredential {
  /** Long-lived ChatGPT OAuth refresh token (rotates on redemption). */
  refreshToken: string;
  /**
   * The ChatGPT `account_id` (a.k.a. `chatgpt_account_id`), read from the
   * id_token JWT at connect time and sent as the `chatgpt-account-id` header on
   * every Codex request. Required — the Codex backend rejects requests without it.
   */
  accountId: string;
}

/** True when a resolved credential string is a ChatGPT-subscription credential. */
export function isOpenAiCodexCredential(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(OPENAI_CODEX_CREDENTIAL_MARKER)
  );
}

/**
 * True when a specific credential must be governed as **per-user** — personal
 * scope only, owner-matched, never shared through team/org or multi-provider
 * (model-router) virtual keys. Two cases collapse here: the provider is
 * inherently per-user (GitHub / Microsoft Copilot), or the secret is a
 * ChatGPT-subscription (Codex) credential, which is one person's ChatGPT account
 * and must get the identical treatment on the `openai` provider.
 *
 * Unlike `providerRequiresPerUserCredential` (provider-only), this is the
 * KEY-level check: pass the resolved secret so a Codex credential is recognized.
 */
export function credentialRequiresPerUserScope(params: {
  provider: SupportedProvider;
  apiKey: string | null | undefined;
}): boolean {
  return (
    providerRequiresPerUserCredential(params.provider) ||
    isOpenAiCodexCredential(params.apiKey ?? undefined)
  );
}

/**
 * User-facing label for a per-user credential in enforcement messages: the
 * "ChatGPT Subscription" auth mode reads better than the raw `openai` provider.
 */
export function perUserCredentialLabel(params: {
  provider: SupportedProvider;
  apiKey: string | null | undefined;
}): string {
  return isOpenAiCodexCredential(params.apiKey ?? undefined)
    ? "ChatGPT Subscription"
    : params.provider;
}

export function encodeOpenAiCodexCredential(
  credential: OpenAiCodexCredential,
): string {
  // Fail loudly at encode time rather than minting a valid-looking string that
  // only breaks later at request time (decode rejects the same empty values).
  if (!credential.refreshToken || !credential.accountId) {
    throw new Error(
      "Cannot encode ChatGPT credential with empty refreshToken or accountId",
    );
  }
  const json = JSON.stringify(credential);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return `${OPENAI_CODEX_CREDENTIAL_MARKER}${b64}`;
}

export function decodeOpenAiCodexCredential(
  value: string | undefined,
): OpenAiCodexCredential | null {
  if (!isOpenAiCodexCredential(value)) {
    return null;
  }
  try {
    const b64 = (value as string).slice(OPENAI_CODEX_CREDENTIAL_MARKER.length);
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<OpenAiCodexCredential>;
    if (!parsed.refreshToken || !parsed.accountId) {
      return null;
    }
    return {
      refreshToken: parsed.refreshToken,
      accountId: parsed.accountId,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts the ChatGPT `account_id` from an OAuth id_token (or access_token)
 * JWT. The id is a claim carried either at the top level or namespaced under
 * `https://api.openai.com/auth` — both shapes are checked, matching the Codex
 * CLI and OpenCode. Returns undefined if the token can't be parsed or the claim
 * is absent (the connect flow then fails with a clear "no account id" error).
 *
 * This is a plain JWT payload decode — the token's signature is NOT verified,
 * because it was just obtained over TLS directly from the OpenAI token endpoint.
 */
export function extractChatgptAccountId(jwt: string): string | undefined {
  const claims = decodeJwtClaims(jwt);
  if (!claims) {
    return undefined;
  }
  const namespaced = claims["https://api.openai.com/auth"];
  const fromNamespace =
    isRecord(namespaced) && typeof namespaced.chatgpt_account_id === "string"
      ? namespaced.chatgpt_account_id
      : undefined;
  const topLevel =
    typeof claims.chatgpt_account_id === "string"
      ? claims.chatgpt_account_id
      : undefined;
  return topLevel ?? fromNamespace;
}

/**
 * The set of models Archestra surfaces for a ChatGPT-subscription credential.
 * The Codex backend (`chatgpt.com/backend-api/codex`) exposes no public
 * `/models` endpoint and availability is governed by the account's plan, so
 * (like Perplexity/MiniMax) the list is maintained here rather than synced.
 * These are subscription-billed, so their token price is treated as zero.
 *
 * Manually curated — update when OpenAI adds or removes Codex models.
 * Last synchronized: 2026-07 (Codex CLI model set).
 */
export const OPENAI_CODEX_MODELS = [
  { id: "gpt-5.5-codex", displayName: "GPT-5.5 Codex" },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.1-codex", displayName: "GPT-5.1 Codex" },
  { id: "gpt-5.1-codex-mini", displayName: "GPT-5.1 Codex Mini" },
  { id: "codex-mini-latest", displayName: "Codex Mini" },
] as const;

/**
 * Base system instructions sent as the Responses `instructions` field on every
 * Codex request. The Codex backend expects the Codex persona here (an arbitrary
 * caller system prompt belongs in the conversation input, not this field), so
 * the caller's own system message is forwarded as a developer input item while
 * this Codex preamble stays in `instructions`. Kept intentionally small; the
 * agent's real instructions still reach the model via the input.
 */
export const OPENAI_CODEX_INSTRUCTIONS =
  "You are a coding agent running in Archestra, powered by a GPT-5 Codex model " +
  "accessed through the user's ChatGPT subscription. Follow the user's and the " +
  "developer's instructions, use the provided tools when helpful, and be " +
  "concise and correct.";

/**
 * Decodes (without verifying) the payload claims of a JWT. Shared by the token
 * manager's expiry read and the account-id extraction here so the base64url
 * normalization lives in one place. Signature verification is unnecessary: these
 * tokens are obtained over TLS directly from the OpenAI token endpoint.
 */
export function decodeJwtClaims(
  jwt: string,
): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const json = Buffer.from(base64UrlToBase64(parts[1]), "base64").toString(
      "utf8",
    );
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ===== Internal helpers =====

function base64UrlToBase64(value: string): string {
  const replaced = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = replaced.length % 4;
  return padding === 0 ? replaced : replaced + "=".repeat(4 - padding);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
