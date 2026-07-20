import {
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";

/**
 * Thrown when an inference call needs a per-user credential the acting user
 * hasn't linked — a per-user-credential provider (e.g. GitHub Copilot) with no
 * personal key, or a credential-level case like a ChatGPT-subscription (Codex)
 * key on `openai` that belongs to someone else. Surfaces are expected to catch
 * this and prompt the user to link their own account — an interactive card in
 * web chat, a text+link reply in Slack/Teams, or a clear actionable error
 * elsewhere — rather than falling back to someone else's token.
 */
export class LlmProviderAuthRequiredError extends Error {
  readonly provider: SupportedProvider;
  readonly providerLabel: string;

  /**
   * `providerLabel` overrides the display name for credential-level cases
   * where the provider name alone is wrong ("ChatGPT Subscription", not
   * "OpenAI") — see `perUserCredentialLabel`.
   */
  constructor(provider: SupportedProvider, providerLabel?: string) {
    const label = providerLabel ?? providerDisplayNames[provider];
    super(
      `${label} requires each user to connect their own account; the current user has not linked one.`,
    );
    this.name = "LlmProviderAuthRequiredError";
    this.provider = provider;
    this.providerLabel = label;
  }
}
