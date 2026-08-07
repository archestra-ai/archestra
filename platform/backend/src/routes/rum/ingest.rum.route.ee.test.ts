import {
  RUM_EVENT_ALLOWED_ATTRIBUTES,
  RUM_MAX_EVENTS_PER_BATCH,
  type RumAttributeValue,
} from "@archestra/shared";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import { rumExporter } from "@/observability/rum/exporter.ee";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// cacheManager needs a live PostgreSQL connection that PGlite tests don't
// have; back it with the canonical Map-backed fake from
// src/__mocks__/cache-manager.ts so the ingest rate limiter runs for real
// against an in-memory store (reset before every test).
vi.mock("@/cache-manager");

describe("POST /api/rum/events", () => {
  let app: FastifyInstanceWithZod;
  let user: User;

  const makeEvent = (overrides: Record<string, unknown> = {}) => ({
    name: "archestra.page_view",
    timestampMs: Date.now(),
    sessionId: "11111111-2222-4333-8444-555555555555",
    attributes: { "url.path": "/chat" },
    ...overrides,
  });

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organization.id;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: rumRoutes } = await import("./rum.routes.ee");
    await app.register(rumRoutes);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  test("forwards the batch to the exporter on behalf of the session user", async () => {
    const emitSpy = vi
      .spyOn(rumExporter, "emit")
      .mockImplementation((events) => events.length);

    const events = [
      makeEvent(),
      makeEvent({
        name: "archestra.message_sent",
        attributes: { messageLength: 42, hasSkill: false },
      }),
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: { events },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 2 });
    expect(emitSpy).toHaveBeenCalledWith(events, { userId: user.id });
  });

  test("strips attributes outside the event's allowlist before export", async () => {
    const emitSpy = vi
      .spyOn(rumExporter, "emit")
      .mockImplementation((events) => events.length);

    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: {
        events: [
          makeEvent({
            name: "archestra.message_sent",
            attributes: {
              conversationId: "52092964-0000-4000-8000-000000000000",
              agentId: "7ea04b80-0000-4000-8000-000000000000",
              messageLength: 42,
              fileCount: 0,
              hasSkill: false,
            },
          }),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [strippedEvents] = emitSpy.mock.calls[0];
    expect(strippedEvents[0].attributes).toEqual({
      messageLength: 42,
      fileCount: 0,
      hasSkill: false,
    });
  });

  test("accepts the full allowlisted attribute set of every event in one batch", async () => {
    const emitSpy = vi
      .spyOn(rumExporter, "emit")
      .mockImplementation((events) => events.length);

    // Every allowlisted key must satisfy the route's own attribute-key
    // schema (charset/length): one violating key would 400 the whole batch,
    // poisoning every event shipped alongside it.
    const batch = Object.entries(RUM_EVENT_ALLOWED_ATTRIBUTES).map(
      ([name, allowedKeys]) => {
        const attributes = Object.fromEntries(
          allowedKeys.map((key) => [
            key,
            SAMPLE_ATTRIBUTE_VALUES[key] ?? `${key}-sample`,
          ]),
        );
        return { event: makeEvent({ name, attributes }), attributes };
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: { events: batch.map(({ event }) => event) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: batch.length });
    expect(emitSpy).toHaveBeenCalledWith(
      batch.map(({ event, attributes }) => ({
        ...event,
        // Empty attribute bags are omitted from the export.
        attributes: Object.keys(attributes).length ? attributes : undefined,
      })),
      { userId: user.id },
    );
  });

  test("acknowledges with zero accepted when the export pipeline is disabled", async () => {
    // No exporter mock: the test config has no RUM endpoint, so the real
    // (uninitialized) exporter drops the batch.
    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: { events: [makeEvent()] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: 0 });
  });

  test("rejects event names outside the allowlist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: { events: [makeEvent({ name: "free_form_event" })] },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects attribute keys with characters outside the safe set", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: {
        events: [makeEvent({ attributes: { "bad key!": "value" } })],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects batches above the size cap", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/rum/events",
      payload: {
        events: Array.from({ length: RUM_MAX_EVENTS_PER_BATCH + 1 }, makeEvent),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  describe("per-user rate limiting", () => {
    let originalLimit: number;

    beforeEach(() => {
      originalLimit = config.observability.rum.ingestMaxBatchesPerMinute;
      config.observability.rum.ingestMaxBatchesPerMinute = 2;
    });

    afterEach(() => {
      config.observability.rum.ingestMaxBatchesPerMinute = originalLimit;
    });

    const ingest = () =>
      app.inject({
        method: "POST",
        url: "/api/rum/events",
        payload: { events: [makeEvent()] },
      });

    test("rejects batches beyond the per-minute budget and skips the exporter", async () => {
      const emitSpy = vi
        .spyOn(rumExporter, "emit")
        .mockImplementation((events) => events.length);

      expect((await ingest()).statusCode).toBe(200);
      expect((await ingest()).statusCode).toBe(200);

      const rejected = await ingest();
      expect(rejected.statusCode).toBe(429);
      // The rejected batch never reaches the export pipeline.
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });

    test("one user exhausting their budget does not throttle another", async ({
      makeUser,
    }) => {
      vi.spyOn(rumExporter, "emit").mockImplementation(
        (events) => events.length,
      );

      await ingest();
      await ingest();
      expect((await ingest()).statusCode).toBe(429);

      // The onRequest hook reads `user` per request; swap in a fresh one.
      user = await makeUser();

      expect((await ingest()).statusCode).toBe(200);
    });

    test("fails open when the rate-limit store is unavailable", async () => {
      const emitSpy = vi
        .spyOn(rumExporter, "emit")
        .mockImplementation((events) => events.length);
      // A cache outage must cost the flood protection, never the telemetry.
      vi.spyOn(cacheManager, "set").mockRejectedValue(new Error("cache down"));

      expect((await ingest()).statusCode).toBe(200);
      expect(emitSpy).toHaveBeenCalledTimes(1);
    });

    test("the budget resets after the window elapses", async () => {
      vi.spyOn(rumExporter, "emit").mockImplementation(
        (events) => events.length,
      );

      const start = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(start);

      await ingest();
      await ingest();
      expect((await ingest()).statusCode).toBe(429);

      nowSpy.mockReturnValue(start + 61_000);

      expect((await ingest()).statusCode).toBe(200);
    });
  });
});

// === Internal helpers ===

// Plausible per-key values covering every value type the ingest schema
// accepts (string/number/boolean); keys missing here (future allowlist
// additions) fall back to a generated string sample.
const SAMPLE_ATTRIBUTE_VALUES: Record<string, RumAttributeValue> = {
  "url.path": "/settings",
  referrerPath: "/",
  wizardLabel: "Quickstart",
  pageCount: 7,
  scope: "organization",
  stage: "oauth",
  connectorType: "google-drive",
  messageLength: 42,
  fileCount: 2,
  hasSkill: true,
  promptLength: 120,
  mediaType: "application/pdf",
  "browser.web_vital.name": "LCP",
  "browser.web_vital.value": 2412,
  "browser.web_vital.rating": "good",
  ttfbMs: 120,
  domContentLoadedMs: 480,
  loadMs: 1500,
  durationMs: 87,
  "error.type": "TypeError",
  fingerprint: "a1b2c3d4",
  "http.request.method": "POST",
  "http.response.status_code": 200,
  eventType: "click",
  targetTag: "button",
  targetTestId: "install-server",
};
