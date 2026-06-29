import {
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";

/**
 * Thrown when an inference call targets a per-user-credential provider (e.g.
 * GitHub Copilot) but the acting user hasn't linked their account, so there is
 * no personal key to resolve. Surfaces are expected to catch this and prompt
 * the user to link — an interactive card in web chat, a text+link reply in
 * Slack/Teams, or a clear actionable error elsewhere — rather than falling back
 * to someone else's token.
 */
export class LlmProviderAuthRequiredError extends Error {
  readonly provider: SupportedProvider;
  readonly providerLabel: string;

  constructor(provider: SupportedProvider) {
    const providerLabel = providerDisplayNames[provider];
    super(
      `${providerLabel} requires each user to connect their own account; the current user has not linked one.`,
    );
    this.name = "LlmProviderAuthRequiredError";
    this.provider = provider;
    this.providerLabel = providerLabel;
  }
}
