import {
  archestraApiSdk,
  pickAllowedRumAttributes,
  RUM_MAX_ATTRIBUTE_VALUE_LENGTH,
  RUM_MAX_EVENTS_PER_BATCH,
  type RumEventName,
} from "@archestra/shared";

/**
 * Product-usage (RUM) client: batches curated usage events and posts them
 * same-origin to /api/rum/events, where the backend forwards them as OTLP log
 * records to the deployment-configured collector. Runs only when the public
 * config reports RUM as enabled and a user is signed in — see RumTracker.
 *
 * Sessions follow the OTEL session semantic conventions: an id minted here,
 * rotated after 30 minutes of inactivity or 4 hours total, persisted in
 * localStorage so it spans tabs and reloads. "Time spent" is derived from
 * once-a-minute heartbeats while the tab is visible, because browsers give no
 * reliable end-of-session signal.
 */
class RumClient {
  private queue: QueuedRumEvent[] = [];
  private started = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private removePageLifecycleListeners: (() => void) | null = null;
  private removeErrorListeners: (() => void) | null = null;
  private removeInteractionListeners: (() => void) | null = null;
  private interactionsOnPage = 0;
  private sampleRate = 1;
  private lastErrorSentAt = new Map<string, number>();
  private longTaskObserver: PerformanceObserver | null = null;
  private lastPagePath: string | null = null;
  private pendingWebVitals: WebVitalMetric[] = [];
  private pageLoadTracked = false;
  private installedFetchWrapper: typeof window.fetch | null = null;
  private longTasksOnPage = 0;
  private errorsOnPage = 0;
  private apiRequestsOnPage = 0;

  start(options?: { sampleRate?: number }) {
    if (this.started || typeof window === "undefined") {
      return;
    }
    this.started = true;
    const rate = options?.sampleRate;
    this.sampleRate =
      typeof rate === "number" && rate >= 0 && rate <= 1 ? rate : 1;

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        this.track("archestra.session.heartbeat");
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Flush through sendBeacon when the page may be going away — regular
    // fetches are aborted on unload, beacons are delivered by the browser.
    const flushBeacon = () => {
      if (document.visibilityState === "hidden") {
        this.flush({ useBeacon: true });
      }
    };
    document.addEventListener("visibilitychange", flushBeacon);
    window.addEventListener("pagehide", flushBeacon);
    this.removePageLifecycleListeners = () => {
      document.removeEventListener("visibilitychange", flushBeacon);
      window.removeEventListener("pagehide", flushBeacon);
    };

    this.collectPageLoad();
    this.observeLongTasks();
    this.listenForErrors();
    this.listenForInteractions();
    this.instrumentApiRequests();
    for (const metric of this.pendingWebVitals.splice(0)) {
      this.trackWebVital(metric);
    }
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.flush({ useBeacon: true });
    this.started = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.heartbeatTimer = null;
    this.removePageLifecycleListeners?.();
    this.removePageLifecycleListeners = null;
    this.removeErrorListeners?.();
    this.removeErrorListeners = null;
    this.removeInteractionListeners?.();
    this.removeInteractionListeners = null;
    this.longTaskObserver?.disconnect();
    this.longTaskObserver = null;
    // lastPagePath and pageLoadTracked deliberately survive stop(): a
    // stop/start cycle inside one document (an effect re-run, a transient
    // session blip) must not re-emit a page view or page load for a document
    // the user never left. Only reset() — a real sign-out — forgets them.
  }

  trackPageView(rawPath: string) {
    // Clipped like every other string attribute: an over-long path would
    // otherwise fail the server's value-length validation and drop the whole
    // batch it rides in.
    const path = normalizePath(rawPath).slice(
      0,
      RUM_MAX_ATTRIBUTE_VALUE_LENGTH,
    );
    if (path === this.lastPagePath) {
      return;
    }
    const referrerPath = this.lastPagePath;
    this.lastPagePath = path;
    // Noise caps for the chatty performance signals are per page.
    this.longTasksOnPage = 0;
    this.errorsOnPage = 0;
    this.apiRequestsOnPage = 0;
    this.interactionsOnPage = 0;
    this.track("archestra.page_view", {
      // url.path semconv; the route is normalized (ids replaced) so no
      // entity identifiers leave the browser, and dashboards aggregate by
      // route pattern instead of exploding on raw URLs.
      "url.path": path,
      ...(referrerPath ? { referrerPath } : {}),
    });
  }

  /**
   * Mirror of the PostHog product-event taxonomy (lib/analytics.ts). The
   * template-literal type keeps the mirrored names inside the RUM allowlist
   * at compile time, and the shared per-event attribute allowlist strips
   * entity ids and free text the in-product sink may see but the export
   * must not.
   */
  trackProductEvent(
    name: Extract<RumEventName, `archestra.${string}`>,
    properties: Record<string, string | number | boolean | undefined>,
  ) {
    this.track(
      name,
      pickAllowedRumAttributes(name, sanitizeAttributes(properties)),
    );
  }

  /**
   * Report a finalized Core Web Vital (from Next's useReportWebVitals).
   * TTFB and FCP usually finalize before sign-in completes and the client
   * starts, so pre-start metrics are held and drained on start() instead of
   * being dropped.
   */
  trackWebVital(metric: WebVitalMetric) {
    if (!this.started) {
      if (this.pendingWebVitals.length < MAX_PENDING_WEB_VITALS) {
        this.pendingWebVitals.push(metric);
      }
      return;
    }
    // CLS is a unitless score around 0.1; everything else is milliseconds.
    const value =
      metric.name === "CLS"
        ? Math.round(metric.value * 10000) / 10000
        : Math.round(metric.value);
    this.track("browser.web_vital", {
      "browser.web_vital.name": metric.name,
      "browser.web_vital.value": value,
      ...(metric.rating ? { "browser.web_vital.rating": metric.rating } : {}),
      ...this.currentPagePathAttribute(),
    });
  }

  /**
   * Report the signed-in user. Emits `archestra.user_authenticated` once per
   * sign-in on this browser: the marker persists across reloads and is
   * cleared by reset() on sign-out, so the next sign-in emits again. Owned
   * here rather than mirrored from the in-product analytics because that
   * call site sits behind PostHog initialization, which a RUM-only
   * deployment never reaches.
   */
  setUser(userId: string) {
    if (!this.started) {
      return;
    }
    if (readStoredValue(LAST_USER_STORAGE_KEY) !== userId) {
      this.track("archestra.user_authenticated");
      writeStoredValue(LAST_USER_STORAGE_KEY, userId);
    }
  }

  /**
   * Sign-out teardown: flush what is pending (while the session cookie is
   * still valid), stop, and forget the session and last-user markers so a
   * browser session never outlives the user who produced it — on a shared
   * machine the next sign-in would otherwise inherit the previous user's
   * session id for up to the inactivity window.
   */
  reset() {
    this.stop();
    this.lastPagePath = null;
    this.pageLoadTracked = false;
    this.pendingWebVitals = [];
    this.longTasksOnPage = 0;
    this.errorsOnPage = 0;
    this.apiRequestsOnPage = 0;
    this.interactionsOnPage = 0;
    this.lastErrorSentAt.clear();
    try {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      window.localStorage.removeItem(LAST_USER_STORAGE_KEY);
    } catch {
      // Storage unavailable — nothing persisted, nothing to clear.
    }
  }

  private track(name: RumEventName, attributes?: RumAttributes) {
    if (!this.started) {
      return;
    }
    const session = this.touchSession();
    // Session-level sampling: the decision is a pure function of the
    // session id, so it is stable across tabs and reloads and whole
    // sessions stay coherent. Errors are exempt — an error rate must never
    // be sampled away.
    if (
      name !== "archestra.client_error" &&
      !isSessionSampled(session.id, this.sampleRate)
    ) {
      return;
    }
    this.queue.push({
      name,
      timestampMs: Date.now(),
      sessionId: session.id,
      ...(session.previousId ? { previousSessionId: session.previousId } : {}),
      ...(attributes && Object.keys(attributes).length > 0
        ? { attributes }
        : {}),
    });
    if (this.queue.length >= FLUSH_QUEUE_THRESHOLD) {
      this.flush();
    }
  }

  /**
   * Return the current session, rotating it when it expired. Rotation also
   * enqueues the `session.start` event so every session is countable.
   */
  private touchSession(): StoredSession {
    const now = Date.now();
    const stored = readStoredSession();
    if (
      stored &&
      now - stored.lastActivityAt <= SESSION_INACTIVITY_TIMEOUT_MS &&
      now - stored.startedAt <= SESSION_MAX_DURATION_MS
    ) {
      stored.lastActivityAt = now;
      writeStoredSession(stored);
      return stored;
    }

    const session: StoredSession = {
      id: generateSessionId(),
      ...(stored ? { previousId: stored.id } : {}),
      startedAt: now,
      lastActivityAt: now,
    };
    writeStoredSession(session);
    // This push bypasses track(), so it must apply the sampling verdict
    // itself — otherwise sampled-out sessions still report session.start and
    // session counts read unsampled while everything else is sampled.
    if (isSessionSampled(session.id, this.sampleRate)) {
      this.queue.push({
        name: "session.start",
        timestampMs: now,
        sessionId: session.id,
        ...(session.previousId
          ? { previousSessionId: session.previousId }
          : {}),
      });
    }
    return session;
  }

  private flush({ useBeacon = false }: { useBeacon?: boolean } = {}) {
    while (this.queue.length > 0) {
      const events = this.queue.splice(0, RUM_MAX_EVENTS_PER_BATCH);
      if (useBeacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(
          INGEST_URL,
          new Blob([JSON.stringify({ events })], { type: "application/json" }),
        );
      } else {
        // Fire-and-forget: losing telemetry must never surface to the user.
        archestraApiSdk.ingestRumEvents({ body: { events } }).catch(() => {});
      }
    }
  }

  /** One `archestra.page_load` per document, from the Navigation Timing API. */
  private collectPageLoad() {
    const capture = () => {
      if (this.pageLoadTracked || !this.started) {
        return;
      }
      const [navigation] = performance.getEntriesByType(
        "navigation",
      ) as PerformanceNavigationTiming[];
      if (!navigation || navigation.loadEventEnd <= 0) {
        return;
      }
      this.pageLoadTracked = true;
      this.track("archestra.page_load", {
        ttfbMs: Math.round(navigation.responseStart),
        domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
        loadMs: Math.round(navigation.loadEventEnd),
        ...this.currentPagePathAttribute(),
      });
    };
    if (document.readyState === "complete") {
      capture();
    } else {
      // loadEventEnd is only populated after every load handler ran.
      window.addEventListener("load", () => setTimeout(capture, 0), {
        once: true,
      });
    }
  }

  private observeLongTasks() {
    if (
      this.longTaskObserver ||
      typeof PerformanceObserver === "undefined" ||
      !PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      return;
    }
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (this.longTasksOnPage >= MAX_LONG_TASKS_PER_PAGE) {
          return;
        }
        this.longTasksOnPage += 1;
        this.track("archestra.long_task", {
          durationMs: Math.round(entry.duration),
          ...this.currentPagePathAttribute(),
        });
      }
    });
    try {
      observer.observe({ type: "longtask", buffered: true });
      this.longTaskObserver = observer;
    } catch {
      // Entry type unsupported despite the feature check — skip the signal.
    }
  }

  /**
   * Wrap window.fetch once per document so every same-origin /api/ call —
   * including ones added by future features, with no per-call-site work —
   * reports method, normalized path, status, and duration. The wrapper
   * outlives stop() (unwrapping under later patches by other code is
   * hazardous); it just stops reporting while the client is stopped.
   */
  private instrumentApiRequests() {
    if (
      typeof window.fetch !== "function" ||
      window.fetch === this.installedFetchWrapper
    ) {
      return;
    }
    const originalFetch = window.fetch.bind(window);
    const wrapper = async (input: RequestInfo | URL, init?: RequestInit) => {
      const startedAt = performance.now();
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      try {
        const response = await originalFetch(input, init);
        this.trackApiRequest(
          url,
          method,
          response.status,
          performance.now() - startedAt,
        );
        return response;
      } catch (error) {
        // Network-level failure; status 0 mirrors the browser convention.
        this.trackApiRequest(url, method, 0, performance.now() - startedAt);
        throw error;
      }
    };
    this.installedFetchWrapper = wrapper;
    window.fetch = wrapper;
  }

  private trackApiRequest(
    rawUrl: string,
    method: string,
    status: number,
    durationMs: number,
  ) {
    if (!this.started) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl, window.location.origin);
    } catch {
      return;
    }
    if (
      parsed.origin !== window.location.origin ||
      !parsed.pathname.startsWith("/api/") ||
      // Never report the report itself.
      parsed.pathname === INGEST_URL
    ) {
      return;
    }
    if (this.apiRequestsOnPage >= MAX_API_REQUESTS_PER_PAGE) {
      return;
    }
    this.apiRequestsOnPage += 1;
    this.track("archestra.api_request", {
      "http.request.method": method,
      "url.path": normalizePath(parsed.pathname).slice(
        0,
        RUM_MAX_ATTRIBUTE_VALUE_LENGTH,
      ),
      "http.response.status_code": status,
      durationMs: Math.round(durationMs),
    });
  }

  /**
   * Auto-capture DOM interactions at the document (capture phase), so any
   * future feature's UI is covered with zero per-feature instrumentation.
   * The reported target is structural only — tag plus a sanitized
   * data-testid — never element text, input values, or key identities.
   */
  private listenForInteractions() {
    if (this.removeInteractionListeners) {
      return;
    }
    const handler = (event: Event) => {
      if (this.interactionsOnPage >= MAX_INTERACTIONS_PER_PAGE) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      this.interactionsOnPage += 1;
      const testId = target
        .closest("[data-testid]")
        ?.getAttribute("data-testid");
      this.track("archestra.interaction", {
        eventType: event.type,
        targetTag: target.tagName.toLowerCase().slice(0, 32),
        ...(testId ? { targetTestId: sanitizeTestId(testId) } : {}),
        ...this.currentPagePathAttribute(),
      });
    };
    for (const type of INTERACTION_EVENT_TYPES) {
      document.addEventListener(type, handler, {
        capture: true,
        passive: true,
      });
    }
    this.removeInteractionListeners = () => {
      for (const type of INTERACTION_EVENT_TYPES) {
        document.removeEventListener(type, handler, { capture: true });
      }
    };
  }

  private listenForErrors() {
    if (this.removeErrorListeners) {
      return;
    }
    const onError = (event: ErrorEvent) => {
      this.trackClientError(
        event.error instanceof Error ? event.error.name : "Error",
        String(event.message ?? ""),
      );
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      this.trackClientError(
        reason instanceof Error ? reason.name : "UnhandledRejection",
        reason instanceof Error ? reason.message : String(reason),
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    this.removeErrorListeners = () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }

  private trackClientError(type: string, message: string) {
    if (this.errorsOnPage >= MAX_CLIENT_ERRORS_PER_PAGE) {
      return;
    }
    // The message feeds the grouping hash and nothing else — it never
    // leaves the browser.
    const errorFingerprint = fingerprint(`${type}:${message}`);
    // Splunk-style throttle: one report per unique error per second, so an
    // error storm in a render loop cannot flood the pipeline.
    const now = Date.now();
    const lastSentAt = this.lastErrorSentAt.get(errorFingerprint);
    if (lastSentAt !== undefined && now - lastSentAt < 1000) {
      return;
    }
    this.lastErrorSentAt.set(errorFingerprint, now);
    this.errorsOnPage += 1;
    this.track("archestra.client_error", {
      "error.type": type.slice(0, 64),
      fingerprint: errorFingerprint,
      ...this.currentPagePathAttribute(),
    });
  }

  /**
   * Route context for performance events: the deduped page-view path when a
   * navigation was tracked, otherwise the normalized current location (early
   * signals like TTFB can fire before the first page view).
   */
  private currentPagePathAttribute(): Record<"url.path", string> | undefined {
    const path =
      this.lastPagePath ??
      (typeof window !== "undefined"
        ? normalizePath(window.location.pathname).slice(
            0,
            RUM_MAX_ATTRIBUTE_VALUE_LENGTH,
          )
        : null);
    return path ? { "url.path": path } : undefined;
  }
}

export const rumClient = new RumClient();

// === Internal helpers ===

type RumAttributes = Record<string, string | number | boolean>;

/** Shape of what Next's useReportWebVitals hands the tracker. */
interface WebVitalMetric {
  name: string;
  value: number;
  rating?: string;
}

interface QueuedRumEvent {
  name: RumEventName;
  timestampMs: number;
  sessionId: string;
  previousSessionId?: string;
  attributes?: RumAttributes;
}

interface StoredSession {
  id: string;
  previousId?: string;
  startedAt: number;
  lastActivityAt: number;
}

const SESSION_STORAGE_KEY = "archestra_rum_session";
const LAST_USER_STORAGE_KEY = "archestra_rum_last_user";
const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const FLUSH_INTERVAL_MS = 10 * 1000;
const FLUSH_QUEUE_THRESHOLD = 25;
const INGEST_URL = "/api/rum/events";
const MAX_PENDING_WEB_VITALS = 10;
const MAX_LONG_TASKS_PER_PAGE = 50;
const MAX_CLIENT_ERRORS_PER_PAGE = 10;
const MAX_API_REQUESTS_PER_PAGE = 200;
const MAX_INTERACTIONS_PER_PAGE = 500;
// Splunk-parity set minus raw key/pointer chatter; keydown is captured as "a
// key was pressed on this element", never which key.
const INTERACTION_EVENT_TYPES = [
  "click",
  "dblclick",
  "contextmenu",
  "submit",
  "change",
  "keydown",
] as const;

function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, quota) — the marker then lasts one
    // page load, which only means the event may re-fire on the next load.
  }
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredSession).id === "string" &&
      typeof (parsed as StoredSession).startedAt === "number" &&
      typeof (parsed as StoredSession).lastActivityAt === "number"
    ) {
      return parsed as StoredSession;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: StoredSession) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage can be unavailable (private mode, quota); sessions then last
    // one page load, which is still valid telemetry.
  }
}

function generateSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // crypto.randomUUID exists only in secure contexts; getRandomValues is
  // available everywhere a browser runs this, so plain-http deployments
  // still get a real v4 UUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_SEGMENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT_PATTERN = /^\d+$/;

/**
 * Collapse entity ids in a pathname to `:id` so page views aggregate by route
 * pattern and no identifiers leave the browser. Ids in this app are UUIDs or
 * numbers; anything else is a static route segment.
 */
function normalizePath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      UUID_SEGMENT_PATTERN.test(segment) ||
      NUMERIC_SEGMENT_PATTERN.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

/**
 * Deterministic per-session sampling: the first 4 bytes of the (crypto-
 * random) session id, scaled to [0, 1), compared against the configured
 * rate. No extra randomness, identical verdict in every tab.
 */
function isSessionSampled(sessionId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const prefix = Number.parseInt(sessionId.replace(/-/g, "").slice(0, 8), 16);
  if (!Number.isFinite(prefix)) return true;
  return prefix / 0x100000000 < sampleRate;
}

/**
 * data-testid values are developer-authored and static, but some templates
 * embed entity ids ("agent-row-<uuid>") — collapse those like route segments.
 */
function sanitizeTestId(testId: string): string {
  return testId
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ":id",
    )
    .replace(/\d{3,}/g, ":id")
    .slice(0, 64);
}

/**
 * djb2 over the error text, hex-encoded. Occurrences of the same error group
 * under one value without the text itself ever being transmitted.
 */
function fingerprint(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeAttributes(
  properties: Record<string, string | number | boolean | undefined>,
): RumAttributes {
  const attributes: RumAttributes = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    attributes[key] =
      typeof value === "string"
        ? value.slice(0, RUM_MAX_ATTRIBUTE_VALUE_LENGTH)
        : value;
  }
  return attributes;
}
