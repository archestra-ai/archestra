import posthog from "posthog-js";

/**
 * Product analytics events captured in PostHog.
 *
 * Event names are stable identifiers used by PostHog insights — renaming one
 * breaks its history, so treat names as append-only. Several of these restore
 * events that existed in the (since removed) desktop app, keeping their
 * original names so the PostHog event definitions resume instead of forking.
 */
type ProductEvents = {
  /** A user completed sign-in on this browser (email, SSO, or 2FA). */
  user_authenticated: Record<string, never>;
  /** A user finished the last step of an onboarding wizard in chat. */
  onboarding_completed: { wizardLabel: string; pageCount: number };
  mcp_server_installed: {
    serverId?: string;
    serverName: string;
    catalogId?: string;
    scope?: string;
  };
  mcp_server_uninstalled: { serverId: string; serverName: string };
  /** An OAuth install came back from the provider without completing. */
  mcp_server_installation_cancelled: { reason: string };
  message_sent: {
    conversationId?: string;
    agentId?: string;
    messageLength: number;
    fileCount: number;
    hasSkill: boolean;
  };
  /** A suggested-prompt tile was clicked on the new-chat screen. */
  prompt_selected: { agentId?: string; promptLength: number };
  skill_created: { skillId?: string };
  /** A file was attached to a sent chat message (one event per file). */
  file_uploaded: { mediaType: string; conversationId?: string };
};

/**
 * Capture a product event. No-ops when analytics is disabled for the
 * instance (PostHog is then never initialized — see PostHogProviderWrapper).
 */
export function trackEvent<TName extends keyof ProductEvents>(
  event: TName,
  properties: ProductEvents[TName],
) {
  if (!posthog.__loaded) {
    return;
  }
  posthog.capture(event, properties);
}
