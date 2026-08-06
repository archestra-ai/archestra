import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      ingestRumEvents: vi.fn().mockResolvedValue({ data: { accepted: 1 } }),
    },
  };
});

import {
  archestraApiSdk,
  RUM_MAX_ATTRIBUTE_VALUE_LENGTH,
} from "@archestra/shared";
import { rumClient } from "./rum.ee";

const mockIngest = vi.mocked(archestraApiSdk.ingestRumEvents);

// Stable instance stubbed onto window.fetch each test, so the client's fetch
// wrapper (installed at start()) always wraps this and API-call tracking is
// observable without real network.
const apiFetchStub = vi.fn();

// Everything the client sent across all flushes, in send order. jsdom has no
// navigator.sendBeacon, so every flush (including the one inside stop/reset)
// goes through the mocked SDK.
const sentEvents = () =>
  mockIngest.mock.calls.flatMap(([options]) => options?.body?.events ?? []);

const eventsNamed = (name: string) =>
  sentEvents().filter((event) => event.name === name);

describe("rumClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    mockIngest.mockClear();
    apiFetchStub.mockReset();
    apiFetchStub.mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", apiFetchStub);
  });

  afterEach(() => {
    // Undo per-test overrides of jsdom globals before the reset flush runs,
    // so a leftover sendBeacon stub or visibility override can never leak
    // into another test even when an assertion failed mid-test.
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "sendBeacon");
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "readyState");
    rumClient.reset();
    vi.useRealTimers();
  });

  test("strips non-allowlisted product-event attributes before sending", async () => {
    rumClient.start();
    rumClient.trackProductEvent("archestra.message_sent", {
      conversationId: "52092964-0000-4000-8000-000000000000",
      agentId: "7ea04b80-0000-4000-8000-000000000000",
      messageLength: 42,
      fileCount: 0,
      hasSkill: false,
    });
    await vi.advanceTimersByTimeAsync(11_000);

    const [event] = eventsNamed("archestra.message_sent");
    expect(event?.attributes).toEqual({
      messageLength: 42,
      fileCount: 0,
      hasSkill: false,
    });
  });

  test("setUser emits user_authenticated once per sign-in, again after sign-out", async () => {
    rumClient.start();
    rumClient.setUser("user-1");
    rumClient.setUser("user-1");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(eventsNamed("archestra.user_authenticated")).toHaveLength(1);

    // Sign-out clears the marker, so the next sign-in emits again.
    rumClient.reset();
    rumClient.start();
    rumClient.setUser("user-1");
    await vi.advanceTimersByTimeAsync(11_000);
    expect(eventsNamed("archestra.user_authenticated")).toHaveLength(2);
  });

  test("reset clears the persisted session and last-user markers", () => {
    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    rumClient.setUser("user-1");
    expect(window.localStorage.getItem("archestra_rum_session")).not.toBeNull();
    expect(
      window.localStorage.getItem("archestra_rum_last_user"),
    ).not.toBeNull();

    rumClient.reset();

    expect(window.localStorage.getItem("archestra_rum_session")).toBeNull();
    expect(window.localStorage.getItem("archestra_rum_last_user")).toBeNull();
  });

  test("the session after a reset is fresh, with no linkage to the previous user's", async () => {
    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    await vi.advanceTimersByTimeAsync(11_000);
    const [firstStart] = eventsNamed("session.start");

    rumClient.reset();
    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    await vi.advanceTimersByTimeAsync(11_000);

    const starts = eventsNamed("session.start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.sessionId).not.toBe(firstStart?.sessionId);
    expect(starts[1]?.previousSessionId).toBeUndefined();
  });

  test("normalizes entity ids out of page-view paths before anything is sent", async () => {
    const uuid = "41490fa8-1a2b-4c3d-8e4f-000000000000";
    rumClient.start();
    rumClient.trackPageView(`/chat/${uuid}/messages/42`);
    rumClient.trackPageView("/settings/auth");
    await vi.advanceTimersByTimeAsync(11_000);

    const pageViews = eventsNamed("archestra.page_view");
    expect(pageViews[0]?.attributes?.["url.path"]).toBe(
      "/chat/:id/messages/:id",
    );
    // Static route segments pass through untouched.
    expect(pageViews[1]?.attributes?.["url.path"]).toBe("/settings/auth");
    // The raw identifier must not appear anywhere in what left the browser.
    expect(JSON.stringify(mockIngest.mock.calls)).not.toContain(uuid);
  });

  test("dedupes repeat views of the same page and carries the referrer path", async () => {
    rumClient.start();
    rumClient.trackPageView("/chat");
    rumClient.trackPageView("/chat");
    rumClient.trackPageView("/tools");
    await vi.advanceTimersByTimeAsync(11_000);

    const pageViews = eventsNamed("archestra.page_view");
    expect(pageViews).toHaveLength(2);
    expect(pageViews[0]?.attributes).toEqual({ "url.path": "/chat" });
    expect(pageViews[1]?.attributes).toEqual({
      "url.path": "/tools",
      referrerPath: "/chat",
    });
  });

  test("a stop/start cycle does not re-emit a page view for the page the user never left", async () => {
    // Regression pin: stop() clearing the dedupe key made every in-document
    // remount (StrictMode in dev, a transient session blip in production)
    // emit a duplicate landing page_view with referrerPath null.
    rumClient.start();
    rumClient.trackPageView("/chat");
    rumClient.stop();

    rumClient.start();
    rumClient.trackPageView("/chat");
    await vi.advanceTimersByTimeAsync(11_000);

    expect(eventsNamed("archestra.page_view")).toHaveLength(1);
  });

  test("a stop/start cycle without reset resumes the persisted session", async () => {
    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    await vi.advanceTimersByTimeAsync(11_000);
    rumClient.stop();

    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    await vi.advanceTimersByTimeAsync(11_000);

    const tracked = eventsNamed("archestra.skill_created");
    expect(tracked).toHaveLength(2);
    expect(tracked[1]?.sessionId).toBe(tracked[0]?.sessionId);
    expect(eventsNamed("session.start")).toHaveLength(1);
  });

  test("rotates the session after 30 minutes of inactivity, chaining to the previous id", async () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const seededId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    window.localStorage.setItem(
      "archestra_rum_session",
      JSON.stringify({
        id: seededId,
        startedAt: Date.now() - 45 * 60_000,
        lastActivityAt: Date.now() - 31 * 60_000,
      }),
    );

    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    await vi.advanceTimersByTimeAsync(11_000);

    const starts = eventsNamed("session.start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.previousSessionId).toBe(seededId);
    expect(starts[0]?.sessionId).not.toBe(seededId);
  });

  test("heartbeats fire once a minute only while the tab is visible", async () => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    rumClient.start();
    await vi.advanceTimersByTimeAsync(71_000);
    expect(eventsNamed("archestra.session.heartbeat")).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(eventsNamed("archestra.session.heartbeat")).toHaveLength(1);
  });

  test("flushes through sendBeacon when the page is hidden, leaving nothing for fetch", async () => {
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit) => true);
    Object.defineProperty(navigator, "sendBeacon", {
      value: sendBeacon,
      configurable: true,
    });

    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeacon.mock.calls[0] ?? [];
    expect(url).toBe("/api/rum/events");
    expect(body).toBeInstanceOf(Blob);
    const payload = JSON.parse(await (body as Blob).text()) as {
      events: Array<{ name: string }>;
    };
    expect(payload.events.map((event) => event.name)).toContain(
      "archestra.skill_created",
    );

    // The beacon drained the queue; the interval flush has nothing to send.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  test("stop() delivers pending events instead of discarding them", () => {
    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    expect(eventsNamed("archestra.skill_created")).toHaveLength(0);

    rumClient.stop();

    expect(eventsNamed("archestra.skill_created")).toHaveLength(1);
  });

  test("web vitals use registry attribute names, buffer pre-start, and carry the route", async () => {
    // TTFB finalizes before sign-in completes — must be buffered, not lost.
    rumClient.trackWebVital({ name: "TTFB", value: 123.6, rating: "good" });

    rumClient.start();
    rumClient.trackPageView("/chat");
    rumClient.trackWebVital({ name: "CLS", value: 0.04321, rating: "good" });
    await vi.advanceTimersByTimeAsync(11_000);

    const vitals = eventsNamed("browser.web_vital");
    expect(vitals).toHaveLength(2);
    expect(vitals[0]?.attributes).toMatchObject({
      "browser.web_vital.name": "TTFB",
      "browser.web_vital.value": 124,
    });
    // CLS keeps its sub-integer scale; everything else rounds to whole ms.
    expect(vitals[1]?.attributes).toEqual({
      "browser.web_vital.name": "CLS",
      "browser.web_vital.value": 0.0432,
      "browser.web_vital.rating": "good",
      "url.path": "/chat",
    });
  });

  test("uncaught errors report type and fingerprint — never the message text", async () => {
    rumClient.start();
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("secret-token-abc123"),
        message: "secret-token-abc123",
      }),
    );
    await vi.advanceTimersByTimeAsync(11_000);

    const [event] = eventsNamed("archestra.client_error");
    expect(event?.attributes?.["error.type"]).toBe("TypeError");
    expect(String(event?.attributes?.fingerprint)).toMatch(/^[0-9a-f]{8}$/);
    // The firewall pin: the message must not appear anywhere on the wire.
    expect(JSON.stringify(mockIngest.mock.calls)).not.toContain("secret-token");
  });

  test("same-origin API calls report method, normalized path, status, and duration", async () => {
    apiFetchStub.mockResolvedValueOnce({ status: 201 });
    rumClient.start();

    const uuid = "52092964-0000-4000-8000-000000000001";
    await window.fetch(`/api/agents/${uuid}/tools`, { method: "post" });
    // The report itself, cross-origin calls, and non-API paths stay silent.
    await window.fetch("/api/rum/events", { method: "POST" });
    await window.fetch("https://elsewhere.example/api/servers");
    await window.fetch("/chat");
    await vi.advanceTimersByTimeAsync(11_000);

    const requests = eventsNamed("archestra.api_request");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.attributes).toMatchObject({
      "http.request.method": "POST",
      "url.path": "/api/agents/:id/tools",
      "http.response.status_code": 201,
    });
    expect(typeof requests[0]?.attributes?.durationMs).toBe("number");
    expect(JSON.stringify(mockIngest.mock.calls)).not.toContain(uuid);
  });

  test("unsampled sessions suppress everything except client errors", async () => {
    // First 4 id bytes ≈ 0xffffffff → fraction ≈ 1 → unsampled at rate 0.5.
    window.localStorage.setItem(
      "archestra_rum_session",
      JSON.stringify({
        id: "ffffffff-aaaa-4bbb-8ccc-000000000000",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
      }),
    );
    rumClient.start({ sampleRate: 0.5 });
    rumClient.trackProductEvent("archestra.skill_created", {});
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("still-visible"),
        message: "still-visible",
      }),
    );
    await vi.advanceTimersByTimeAsync(11_000);

    expect(eventsNamed("archestra.skill_created")).toHaveLength(0);
    expect(eventsNamed("session.start")).toHaveLength(0);
    expect(eventsNamed("archestra.client_error")).toHaveLength(1);
  });

  test("a session created while unsampled does not report session.start", async () => {
    // Empty storage forces the session-creation path, which enqueues
    // session.start outside track(); rate 0 makes every session unsampled.
    rumClient.start({ sampleRate: 0 });
    rumClient.trackProductEvent("archestra.skill_created", {});
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: new TypeError("still-visible"),
        message: "still-visible",
      }),
    );
    await vi.advanceTimersByTimeAsync(11_000);

    // The session itself exists (the error carries its id) — only the
    // events are sampled away, session.start included.
    expect(eventsNamed("session.start")).toHaveLength(0);
    expect(eventsNamed("archestra.skill_created")).toHaveLength(0);
    const [errorEvent] = eventsNamed("archestra.client_error");
    expect(errorEvent?.sessionId).toBeTruthy();
    expect(
      JSON.parse(window.localStorage.getItem("archestra_rum_session") ?? "{}")
        .id,
    ).toBe(errorEvent?.sessionId);
  });

  test("throttles identical errors to one per second", async () => {
    rumClient.start();
    const boom = () =>
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new RangeError("same-every-time"),
          message: "same-every-time",
        }),
      );
    boom();
    boom();
    await vi.advanceTimersByTimeAsync(1500);
    boom();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(eventsNamed("archestra.client_error")).toHaveLength(2);
  });

  test("bounds throttle memory: after 256 distinct errors the map purges and repeats re-report", async () => {
    rumClient.start();
    const boom = (message: string) =>
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new Error(message),
          message,
        }),
      );
    // 26 pages × 10 errors (the per-page cap) = 260 distinct fingerprints,
    // crossing the 256-entry bound and triggering a purge.
    for (let page = 0; page < 26; page++) {
      rumClient.trackPageView(`/errpage-${page}`);
      for (let k = 0; k < 10; k++) boom(`e-${page}-${k}`);
    }
    // The very first fingerprint's throttle entry was purged, so an
    // immediate repeat reports again instead of being throttled.
    rumClient.trackPageView("/errpage-final");
    boom("e-0-0");
    await vi.advanceTimersByTimeAsync(11_000);

    expect(eventsNamed("archestra.client_error")).toHaveLength(261);
  });

  test("auto-captures interactions with structural targets, never element text", async () => {
    rumClient.start();
    const button = document.createElement("button");
    button.setAttribute(
      "data-testid",
      "agent-row-52092964-0000-4000-8000-000000000000-install",
    );
    button.textContent = "Install Very Secret Server";
    document.body.appendChild(button);

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(11_000);
    button.remove();

    const [interaction] = eventsNamed("archestra.interaction");
    expect(interaction?.attributes).toMatchObject({
      eventType: "click",
      targetTag: "button",
      targetTestId: "agent-row-:id-install",
    });
    expect(JSON.stringify(mockIngest.mock.calls)).not.toContain(
      "Very Secret Server",
    );
  });

  test("caps interactions per page and stops capturing after stop()", async () => {
    rumClient.start();
    const div = document.createElement("div");
    document.body.appendChild(div);
    for (let index = 0; index < 510; index++) {
      div.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    rumClient.stop();
    div.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(11_000);
    div.remove();

    expect(eventsNamed("archestra.interaction")).toHaveLength(500);
  });

  test("caps client errors per page", async () => {
    rumClient.start();
    for (let index = 0; index < 15; index++) {
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new Error(`boom-${index}`),
          message: `boom-${index}`,
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(11_000);

    expect(eventsNamed("archestra.client_error")).toHaveLength(10);
  });

  test("emits one page load per document, surviving a stop/start cycle", async () => {
    Object.defineProperty(document, "readyState", {
      value: "complete",
      configurable: true,
    });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      {
        responseStart: 120.4,
        domContentLoadedEventEnd: 480.9,
        loadEventEnd: 1200.2,
      } as unknown as PerformanceEntry,
    ]);

    rumClient.start();
    rumClient.stop();
    rumClient.start();
    await vi.advanceTimersByTimeAsync(11_000);

    const loads = eventsNamed("archestra.page_load");
    expect(loads).toHaveLength(1);
    expect(loads[0]?.attributes).toMatchObject({
      ttfbMs: 120,
      domContentLoadedMs: 481,
      loadMs: 1200,
    });
  });

  test("reports long tasks with their duration, capped per page", async () => {
    type LongTaskCallback = (list: {
      getEntries: () => Array<{ duration: number }>;
    }) => void;
    // Wrapped in an object because TS control-flow analysis cannot see the
    // constructor assignment and would narrow a plain variable to null.
    const captured: { callback: LongTaskCallback } = { callback: () => {} };
    class FakePerformanceObserver {
      static supportedEntryTypes = ["longtask"];
      constructor(callback: LongTaskCallback) {
        captured.callback = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("PerformanceObserver", FakePerformanceObserver);

    rumClient.start();
    captured.callback({
      getEntries: () => Array.from({ length: 60 }, () => ({ duration: 87.5 })),
    });
    await vi.advanceTimersByTimeAsync(11_000);

    const tasks = eventsNamed("archestra.long_task");
    expect(tasks).toHaveLength(50);
    expect(tasks[0]?.attributes).toMatchObject({ durationMs: 88 });
  });

  test("falls back to a well-formed v4 session id when crypto.randomUUID is unavailable", async () => {
    // crypto.randomUUID exists only in secure contexts; a plain-http
    // deployment has just getRandomValues.
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: realCrypto.getRandomValues.bind(realCrypto),
    });

    rumClient.start();
    rumClient.trackProductEvent("archestra.skill_created", {});
    await vi.advanceTimersByTimeAsync(11_000);

    const [event] = eventsNamed("archestra.skill_created");
    expect(event?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("clips over-long page-view paths to the shared attribute limit", async () => {
    rumClient.start();
    rumClient.trackPageView(
      `/settings/${"a".repeat(RUM_MAX_ATTRIBUTE_VALUE_LENGTH + 100)}`,
    );
    await vi.advanceTimersByTimeAsync(11_000);

    const [pageView] = eventsNamed("archestra.page_view");
    const path = String(pageView?.attributes?.["url.path"]);
    expect(path.startsWith("/settings/aaa")).toBe(true);
    expect(path.length).toBeLessThanOrEqual(RUM_MAX_ATTRIBUTE_VALUE_LENGTH);
  });
});
