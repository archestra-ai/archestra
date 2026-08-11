/**
 * Product-usage (RUM — Real User Monitoring) event taxonomy.
 *
 * These are the only event names the RUM ingest endpoint accepts. The list is
 * deliberately closed: it is the wire contract customers build dashboards on,
 * and the allowlist is what keeps free-form (potentially sensitive) telemetry
 * out of the export pipeline. Each name becomes the `event.name` of an OTLP
 * log record, so treat names as append-only — renaming one breaks customer
 * dashboards the same way renaming a metric would.
 *
 * `session.start` follows the OTEL session semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/general/session/) and
 * `browser.web_vital` the browser-events registry (Development stability,
 * same bar as the `gen_ai.*` attributes the backend already emits).
 * Everything else is `archestra.`-namespaced because the registry defines no
 * page-view, page-load, long-task, client-error, or product-event names yet.
 */
export const RUM_EVENT_NAMES = [
  "session.start",
  /**
   * Emitted once a minute while the tab is visible. Browsers give no reliable
   * unload signal for a `session.end`, so "time spent" is aggregated from
   * heartbeats (one-minute resolution) instead.
   */
  "archestra.session.heartbeat",
  "archestra.page_view",
  // Browser performance signals. Numeric measurements plus closed-enum
  // classifications only — the messages, stacks, and per-resource URLs that
  // vendor RUM agents ship stay out of the export contract.
  "browser.web_vital",
  "archestra.page_load",
  "archestra.long_task",
  "archestra.client_error",
  // Same-origin API calls only — no third-party or static-resource
  // waterfall, and paths are normalized like page views.
  "archestra.api_request",
  // Auto-captured DOM interactions (document-level capture listeners), so a
  // future feature's UI is covered without any per-feature instrumentation.
  // Targets are structural only: tag + sanitized data-testid, never element
  // text, values, or key identities.
  "archestra.interaction",
  // Product events mirrored 1:1 (plus prefix) from the in-product analytics
  // taxonomy in frontend/src/lib/analytics.ts.
  "archestra.user_authenticated",
  "archestra.onboarding_completed",
  "archestra.mcp_server_installed",
  "archestra.mcp_server_uninstalled",
  "archestra.mcp_server_installation_cancelled",
  "archestra.mcp_server_installation_failed",
  "archestra.knowledge_base_connector_installation_failed",
  "archestra.message_sent",
  "archestra.message_queued",
  "archestra.prompt_selected",
  "archestra.skill_created",
  "archestra.file_uploaded",
] as const;

export type RumEventName = (typeof RUM_EVENT_NAMES)[number];

export const RUM_MAX_EVENTS_PER_BATCH = 100;
export const RUM_MAX_ATTRIBUTES_PER_EVENT = 20;
export const RUM_MAX_ATTRIBUTE_VALUE_LENGTH = 500;

export type RumAttributeValue = string | number | boolean;

/**
 * Per-event attribute allowlist — the attribute-level counterpart of
 * RUM_EVENT_NAMES. Product events reuse the in-product analytics taxonomy,
 * whose property bags carry entity ids (conversation, agent, server ids) and
 * free text (server names, provider error strings) that the in-product sink
 * may see but the customer-facing export must not: the export contract is
 * that no entity identifiers and no free text leave the deployment. Only the
 * keys listed here survive, enforced on both sides (client before sending,
 * server before exporting). The `satisfies Record<RumEventName, ...>` makes
 * forgetting an entry for a new event a compile error, while `as const`
 * keeps the key literals so the frontend can bind each entry to the real
 * property names of its product event (see the parity guard in
 * frontend/src/lib/analytics.ts).
 */
export const RUM_EVENT_ALLOWED_ATTRIBUTES = {
  "session.start": [],
  "archestra.session.heartbeat": [],
  "archestra.page_view": ["url.path", "referrerPath"],
  // browser.web_vital.* names come from the OTEL browser-events registry.
  "browser.web_vital": [
    "browser.web_vital.name",
    "browser.web_vital.value",
    "browser.web_vital.rating",
    "url.path",
  ],
  "archestra.page_load": ["ttfbMs", "domContentLoadedMs", "loadMs", "url.path"],
  "archestra.long_task": ["durationMs", "url.path"],
  // `error.type` is the error class name (stable OTEL semconv);
  // `fingerprint` is a hash of the message computed in the browser so
  // occurrences group without the message itself ever leaving it.
  "archestra.client_error": ["error.type", "fingerprint", "url.path"],
  // http.request.method / http.response.status_code are stable OTEL semconv;
  // url.path here is the normalized path of the API call itself.
  "archestra.api_request": [
    "http.request.method",
    "url.path",
    "http.response.status_code",
    "durationMs",
  ],
  "archestra.interaction": [
    "eventType",
    "targetTag",
    "targetTestId",
    "url.path",
  ],
  "archestra.user_authenticated": [],
  "archestra.onboarding_completed": ["wizardLabel", "pageCount"],
  "archestra.mcp_server_installed": ["scope"],
  "archestra.mcp_server_uninstalled": [],
  // `reason` is the OAuth provider's error string — externally supplied free
  // text, so it stays out of the export.
  "archestra.mcp_server_installation_cancelled": [],
  "archestra.mcp_server_installation_failed": ["stage"],
  "archestra.knowledge_base_connector_installation_failed": [
    "connectorType",
    "stage",
  ],
  "archestra.message_sent": ["messageLength", "fileCount", "hasSkill"],
  "archestra.message_queued": ["messageLength"],
  "archestra.prompt_selected": ["promptLength"],
  "archestra.skill_created": [],
  "archestra.file_uploaded": ["mediaType"],
} as const satisfies Record<RumEventName, readonly string[]>;

/**
 * Keep only the allowlisted attributes for an event. Returns undefined when
 * nothing survives, so empty attribute bags are omitted from the wire format.
 */
export function pickAllowedRumAttributes(
  name: RumEventName,
  attributes: Record<string, RumAttributeValue> | undefined,
): Record<string, RumAttributeValue> | undefined {
  if (!attributes) {
    return undefined;
  }
  const picked: Record<string, RumAttributeValue> = {};
  for (const key of RUM_EVENT_ALLOWED_ATTRIBUTES[name]) {
    if (key in attributes) {
      picked[key] = attributes[key];
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}
