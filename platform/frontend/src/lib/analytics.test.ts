import posthog from "posthog-js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { rumClient } from "@/lib/rum.ee";
import { clipErrorMessage, trackEvent } from "./analytics";

const { mockCapture } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    __loaded: false,
    capture: mockCapture,
  },
}));

// Stubbed so no RUM batching/network runs; trackEvent's contract here is only
// which events it hands to the RUM singleton.
const trackProductEventSpy = vi
  .spyOn(rumClient, "trackProductEvent")
  .mockImplementation(() => {});

const MESSAGE_SENT_PROPERTIES = {
  conversationId: "52092964-0000-4000-8000-000000000000",
  agentId: "7ea04b80-0000-4000-8000-000000000000",
  messageLength: 42,
  fileCount: 1,
  hasSkill: false,
};

describe("trackEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    posthog.__loaded = false;
  });

  test("mirrors product events to the RUM sink even when PostHog never initialized", () => {
    // A RUM-only deployment (analytics disabled) never loads PostHog; the RUM
    // mirror must fire before the __loaded early-return, not behind it.
    trackEvent("message_sent", MESSAGE_SENT_PROPERTIES);

    expect(trackProductEventSpy).toHaveBeenCalledTimes(1);
    expect(trackProductEventSpy).toHaveBeenCalledWith(
      "archestra.message_sent",
      MESSAGE_SENT_PROPERTIES,
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test("does not mirror user_authenticated to the RUM sink", () => {
    // The RUM client detects sign-ins itself (rumClient.setUser); mirroring
    // this event would double-count on deployments running both sinks.
    posthog.__loaded = true;

    trackEvent("user_authenticated", {});

    expect(trackProductEventSpy).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledWith("user_authenticated", {});
  });

  test("feeds both sinks when PostHog is loaded", () => {
    posthog.__loaded = true;

    trackEvent("message_sent", MESSAGE_SENT_PROPERTIES);

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(
      "message_sent",
      MESSAGE_SENT_PROPERTIES,
    );
    expect(trackProductEventSpy).toHaveBeenCalledTimes(1);
    expect(trackProductEventSpy).toHaveBeenCalledWith(
      "archestra.message_sent",
      MESSAGE_SENT_PROPERTIES,
    );
  });
});

describe("clipErrorMessage", () => {
  test("returns undefined for non-string or empty input", () => {
    expect(clipErrorMessage(undefined)).toBeUndefined();
    expect(clipErrorMessage(null)).toBeUndefined();
    expect(clipErrorMessage(42)).toBeUndefined();
    expect(clipErrorMessage(new Error("boom"))).toBeUndefined();
    expect(clipErrorMessage("")).toBeUndefined();
  });

  test("clips an over-long message to 200 characters", () => {
    expect(clipErrorMessage("x".repeat(300))).toBe("x".repeat(200));
  });

  test("passes a short message through unchanged", () => {
    expect(clipErrorMessage("connection refused")).toBe("connection refused");
  });
});
