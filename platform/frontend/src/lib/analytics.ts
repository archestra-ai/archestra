import type { RUM_EVENT_ALLOWED_ATTRIBUTES } from "@archestra/shared";
import posthog from "posthog-js";
// biome-ignore lint/style/noRestrictedImports: dual-licensed; the client no-ops unless RUM is enabled
import { rumClient } from "@/lib/rum.ee";

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
  /**
   * An install didn't complete: the install request was rejected ("request")
   * or the local server's pod failed to come up afterwards ("runtime").
   */
  mcp_server_installation_failed: {
    serverId?: string;
    serverName?: string;
    catalogId?: string;
    stage: "request" | "runtime";
    errorMessage?: string;
  };
  /** A knowledge base connector could not be created or failed its connection test. */
  knowledge_base_connector_installation_failed: {
    connectorType?: string;
    stage: "create" | "connection_test";
    errorMessage?: string;
  };
  message_sent: {
    conversationId?: string;
    agentId?: string;
    messageLength: number;
    fileCount: number;
    hasSkill: boolean;
  };
  /** A message was queued while a response was still streaming. */
  message_queued: {
    conversationId?: string;
    agentId?: string;
    messageLength: number;
  };
  /** A suggested-prompt tile was clicked on the new-chat screen. */
  prompt_selected: { agentId?: string; promptLength: number };
  skill_created: { skillId?: string };
  /** A file was attached to a sent chat message (one event per file). */
  file_uploaded: { mediaType: string; conversationId?: string };
};

/**
 * Compile-time parity between the RUM attribute allowlist and the real
 * property names of each mirrored product event. If an allowlist entry in
 * shared/rum.ts names a property that does not exist on the event (e.g.
 * after a property rename here), the offending event key survives the mapped
 * type below and the empty-object assignment fails to compile, naming it.
 * Without this, a stale allowlist key would silently strip the attribute
 * from the customer-facing export forever.
 */
type RumAllowlistParityViolations = {
  [K in keyof ProductEvents as (typeof RUM_EVENT_ALLOWED_ATTRIBUTES)[`archestra.${K}`][number] extends keyof ProductEvents[K]
    ? never
    : K]: never;
};
const _rumAllowlistParity: RumAllowlistParityViolations = {};

/**
 * Capture a product event. No-ops when analytics is disabled for the
 * instance (PostHog is then never initialized — see PostHogProviderWrapper).
 */
export function trackEvent<TName extends keyof ProductEvents>(
  event: TName,
  properties: ProductEvents[TName],
) {
  // Product events also feed the customer-facing RUM export (a no-op unless
  // the deployment configured a RUM endpoint) — one taxonomy, two sinks.
  // Exception: user_authenticated. This call site only runs after PostHog
  // initializes, which a RUM-only deployment never reaches, so the RUM client
  // detects sign-ins itself (rumClient.setUser) and mirroring it here would
  // double-count on deployments running both sinks.
  if (event !== "user_authenticated") {
    rumClient.trackProductEvent(`archestra.${event}`, properties);
  }

  if (!posthog.__loaded) {
    return;
  }
  posthog.capture(event, properties);
}

/**
 * Clip an error message for use as an event property: enough to tell failure
 * modes apart in PostHog without shipping whole stack traces or payloads.
 */
export function clipErrorMessage(message: unknown): string | undefined {
  if (typeof message !== "string" || message.length === 0) {
    return undefined;
  }
  return message.slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

const ERROR_MESSAGE_MAX_LENGTH = 200;
