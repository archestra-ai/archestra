import type { SupportedProvider } from "@archestra/shared";

/**
 * Core shape test shared by the proxy header path and the chat body-feature
 * gating so the two can't drift. `baseUrlOverridden` means a custom base URL is
 * in play (a per-key override or an internal base-URL header). A Claude model
 * name still counts as native even behind an override (Claude proxied through a
 * gateway), since genuine Anthropic features are what it speaks.
 */
export function isNativeAnthropicModelShape(
  model: string,
  baseUrlOverridden: boolean,
): boolean {
  return !baseUrlOverridden || /claude/i.test(model);
}

/**
 * Whether an Anthropic request targets genuine Anthropic rather than an
 * Anthropic-compatible third-party endpoint (a custom base URL serving a
 * non-Claude model). Anthropic-only request features — the `anthropic-beta`
 * header, `cache_control` markers, and `document` content blocks — are safe to
 * emit only against a native endpoint; a compatible endpoint rejects them with
 * a turn-0 HTTP 400. Non-Anthropic providers are never "native Anthropic".
 */
export function isAnthropicNativeEndpoint(params: {
  provider: SupportedProvider;
  model: string;
  baseUrl?: string | null;
}): boolean {
  return (
    params.provider === "anthropic" &&
    isNativeAnthropicModelShape(params.model, Boolean(params.baseUrl))
  );
}
