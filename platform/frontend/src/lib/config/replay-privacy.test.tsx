import { render, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { PostHog } from "posthog-js";
import { buildNetworkRequestOptions } from "posthog-js/lib/src/extensions/replay/external/config";
import { EventType, type eventWithTime, record } from "posthog-js/rrweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReplayPrivacy } from "@/app/_parts/session-replay-privacy";
import config from "./config";

vi.mock("next/navigation");
let stopRecording: (() => void) | undefined;

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/llm/usage");
});

afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
  document.body.replaceChildren();
});

describe("replay privacy", () => {
  it.each([
    "/chat",
    "/chat/conversation-id",
    "/chat/runs/run-id",
    "/llm/logs/interaction-id",
    "/mcp/logs/call-id",
    "/consults/logs",
    "/connections/logs",
    "/audit/logs",
    "/settings/secrets",
    "/account/api-keys",
    "/projects/project-id",
    "/agents/agent-id",
    "/knowledge/files",
    "/skills/skill-id",
    "/a/app-id",
  ])("blocks text and hidden attributes on %s", async (pathname) => {
    vi.mocked(usePathname).mockReturnValue(pathname);
    render(
      <SessionReplayPrivacy>
        <PrivateContent />
      </SessionReplayPrivacy>,
    );
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );

    const snapshot = JSON.stringify(events);
    expect(snapshot).not.toContain("private-");
    expect(snapshot).not.toContain('"tagName":"main"');
  });

  it("blocks content when navigating into a sensitive screen", async () => {
    const { rerender } = render(
      <SessionReplayPrivacy>
        <main>Usage statistics</main>
      </SessionReplayPrivacy>,
    );
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    expect(JSON.stringify(events)).toContain('"tagName":"main"');
    expect(JSON.stringify(events)).not.toContain("Usage statistics");
    events.length = 0;

    vi.mocked(usePathname).mockReturnValue("/chat/conversation-id");
    rerender(
      <SessionReplayPrivacy>
        <PrivateContent />
      </SessionReplayPrivacy>,
    );
    const navigationMarker = document.createElement("footer");
    navigationMarker.textContent = "Navigation completed";
    document.body.append(navigationMarker);
    await waitFor(() =>
      expect(JSON.stringify(events)).toContain('"tagName":"footer"'),
    );
    expect(JSON.stringify(events)).not.toContain("private-");
  });

  it("blocks sidebars and portaled dialogs even on other screens", async () => {
    render(
      <SessionReplayPrivacy>
        <main>Usage statistics</main>
      </SessionReplayPrivacy>,
    );
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    events.length = 0;
    const portal = document.createElement("div");
    portal.setAttribute("role", "dialog");
    portal.innerHTML =
      '<a href="https://example.com/private-download">private-dialog</a>';
    const sidebar = document.createElement("aside");
    sidebar.dataset.slot = "sidebar";
    sidebar.innerHTML =
      '<a href="/chat/private-id" title="private-title">private-history</a>';
    document.body.append(portal, sidebar);
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.IncrementalSnapshot),
      ).toBe(true),
    );
    expect(JSON.stringify(events)).not.toContain("private-");
  });

  it("keeps product events without automatically capturing clicked content", () => {
    const captured: unknown[] = [];
    const analytics = new PostHog();
    analytics.init("ph_test_privacy", {
      ...config.posthog.config,
      persistence: "memory",
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      capture_pageview: false,
      capture_pageleave: false,
      before_send: (event) => {
        captured.push(event);
        return null;
      },
    });
    try {
      const link = document.createElement("a");
      link.href = "https://example.com/private-source?token=private-token";
      link.textContent = "private-conversation-title";
      link.setAttribute("data-message", "private-message-attribute");
      link.addEventListener("click", (event) => event.preventDefault());
      document.body.append(link);
      link.click();
      analytics.capture("message_sent", { messageLength: 10 });

      expect(JSON.stringify(captured)).toContain('"message_sent"');
      expect(JSON.stringify(captured)).not.toContain('"$autocapture"');
      expect(JSON.stringify(captured)).not.toContain("private-");
    } finally {
      analytics.opt_out_capturing();
    }
  });

  it("keeps network payload capture off when remote settings enable it", () => {
    const options = buildNetworkRequestOptions(
      {
        ...config.posthog.config,
        api_host: "https://analytics.example.com",
      } as Parameters<typeof buildNetworkRequestOptions>[0],
      { recordHeaders: true, recordBody: true, recordPerformance: true },
    );
    expect(options.recordHeaders).toBe(false);
    expect(options.recordBody).toBe(false);
    expect(options.recordPerformance).toBe(true);
  });
});

function PrivateContent() {
  return (
    <main>
      <p>private-conversation-history</p>
      <pre>private-log-payload</pre>
      <input defaultValue="private-input" />
      <a
        href="https://example.com/private-source?token=private-token"
        title="private-title"
        aria-label="private-label"
        data-message="private-attribute"
      >
        private-file
      </a>
    </main>
  );
}

function startRecording(): eventWithTime[] {
  const events: eventWithTime[] = [];
  stopRecording = record({
    ...config.posthog.config.session_recording,
    emit: (event) => events.push(event),
  });
  return events;
}
