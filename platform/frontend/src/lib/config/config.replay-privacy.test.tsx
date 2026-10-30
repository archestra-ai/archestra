import { fireEvent, render, waitFor } from "@testing-library/react";
import { PostHog } from "posthog-js";
import { buildNetworkRequestOptions } from "posthog-js/lib/src/extensions/replay/external/config";
import {
  EventType,
  type eventWithTime,
  IncrementalSource,
  MouseInteractions,
  record,
} from "posthog-js/rrweb";
import { afterEach, describe, expect, it } from "vitest";
import config from "./config";

let stopRecording: (() => void) | undefined;

afterEach(() => {
  stopRecording?.();
  stopRecording = undefined;
  document.body.replaceChildren();
});

describe("replay privacy", () => {
  it("keeps chat and log layouts while masking text and content attributes", async () => {
    render(<PrivateContent />);
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    const captured = captureReplay(events);
    expect(captured).toContain('"tagName":"main"');
    expect(captured).toContain('"tagName":"p"');
    expect(captured).toContain('"tagName":"pre"');
    expect(captured).toContain('"tagName":"input"');
    expect(captured).toContain('"tagName":"a"');
    expect(captured).toContain('"class":"flex flex-col"');
    expect(captured).toContain("color: red");
    expect(captured).not.toContain("private-");
  });

  it("masks newly added content and changed attributes after recording starts", async () => {
    render(
      <main>
        <p>Initial content</p>
      </main>,
    );
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    events.length = 0;
    const link = document.createElement("a");
    link.href = "https://example.com/private-link";
    link.title = "private-title";
    link.textContent = "private-new-message";
    document.querySelector("main")?.append(link);
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(captureReplay(events)).not.toContain("private-");
    events.length = 0;
    link.setAttribute("aria-label", "private-updated-label");
    link.dataset.payload = "private-updated-payload";
    link.style.backgroundImage =
      "url(https://example.com/private-updated-background)";
    link.style.color = "blue";
    link.textContent = "private-updated-text";
    await waitFor(() => expect(events.length).toBeGreaterThan(0));
    const captured = captureReplay(events);
    expect(captured).not.toContain("private-");
    expect(captured).toContain("blue");
  });

  it("preserves sidebar and dialog structure while masking their contents", async () => {
    const { container } = render(<main>Usage statistics</main>);
    const sidebar = document.createElement("aside");
    sidebar.dataset.slot = "sidebar";
    sidebar.innerHTML =
      '<a href="/chat/private-id" title="private-title">private-history</a>';
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = "<p>private-dialog</p>";
    container.append(sidebar, dialog);
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    const captured = captureReplay(events);
    expect(captured).toContain('"tagName":"aside"');
    expect(captured).toContain('"role":"dialog"');
    expect(captured).toContain('"tagName":"a"');
    expect(captured).not.toContain("private-");
  });

  it("blocks media and embedded content without blocking the page", async () => {
    render(
      <main>
        <p>Page content</p>
        <img alt="private-alt" src="https://example.com/private-image" />
        <iframe
          title="private-embedded-content"
          src="https://example.com/private-frame"
        />
      </main>,
    );
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    const captured = captureReplay(events);
    expect(captured).toContain('"tagName":"main"');
    expect(captured).not.toContain("private-");
  });

  it("keeps click events on masked page content", async () => {
    const { getByText } = render(<PrivateContent />);
    const events = startRecording();
    await waitFor(() =>
      expect(
        events.some((event) => event.type === EventType.FullSnapshot),
      ).toBe(true),
    );
    fireEvent.click(getByText("private-file"));
    const captured = JSON.parse(captureReplay(events));
    expect(captured.properties.$snapshot_data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.IncrementalSnapshot,
          data: expect.objectContaining({
            source: IncrementalSource.MouseInteraction,
            type: MouseInteractions.Click,
          }),
        }),
      ]),
    );
  });

  it("drops replay batches that contain packed events it cannot sanitize", () => {
    expect(
      captureReplay([
        {
          type: EventType.FullSnapshot,
          data: "private-packed-data",
          cv: "v1",
          timestamp: 1,
        },
      ]),
    ).toBe("null");
    expect(
      captureReplay([
        {
          type: EventType.FullSnapshot,
          data: { node: {} },
          cv: "v2",
          timestamp: 1,
        },
      ]),
    ).toBe("null");
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
        captured.push(config.posthog.config.before_send(event));
        return null;
      },
    });
    analytics.clear_opt_in_out_capturing();
    try {
      const link = document.createElement("a");
      link.href = "https://example.com/private-source?token=private-token";
      link.textContent = "private-conversation-title";
      link.setAttribute("data-message", "private-message-attribute");
      link.addEventListener("click", (event) => event.preventDefault());
      document.body.append(link);
      link.click();
      analytics.capture("message_sent", {
        messageLength: 10,
        $current_url:
          "https://example.com/chat?user_prompt=private-prompt#private-hash",
        $referrer: "https://example.com/oauth-callback?code=private-code",
        $set_once: {
          $initial_current_url:
            "https://example.com/chat?user_prompt=private-initial-prompt",
        },
      });

      expect(JSON.stringify(captured)).toContain('"message_sent"');
      expect(JSON.stringify(captured)).not.toContain('"$autocapture"');
      expect(JSON.stringify(captured)).not.toContain("private-");
    } finally {
      analytics.opt_out_capturing();
    }
  });

  it("strips private query strings and fragments from replay and network URLs", () => {
    const maskUrl =
      config.posthog.config.session_recording.maskCapturedNetworkRequestFn;
    for (const [name, expected] of [
      [
        "https://example.com/chat?user_prompt=private-prompt#private-fragment",
        "https://example.com/chat",
      ],
      [
        "https://example.com/oauth-callback?code=private-code",
        "https://example.com/oauth-callback",
      ],
      ["/api/chat?token=private-token", "/api/chat"],
      ["https://example.com/llm/usage", "https://example.com/llm/usage"],
    ]) {
      // Replay metadata invokes the callback with only the URL name.
      const result = maskUrl({ name } as Parameters<typeof maskUrl>[0]);
      expect(result.name).toBe(expected);
      expect(JSON.stringify(result)).not.toContain("private-");
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
    <main className="flex flex-col">
      <p
        style={{
          color: "red",
          backgroundImage: "url(https://example.com/private-background)",
        }}
      >
        private-conversation-history
      </p>
      <pre>private-log-payload</pre>
      <input defaultValue="private-input" />
      <a
        href="https://example.com/private-source?token=private-token"
        title="private-title"
        aria-label="private-label"
        data-message="private-attribute"
        onClick={(event) => event.preventDefault()}
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

// Exercise the real SDK capture hook with the recorder's full and incremental events.
function captureReplay(events: unknown): string {
  let captured: unknown;
  const analytics = new PostHog();
  analytics.init("ph_test_privacy", {
    ...config.posthog.config,
    persistence: "memory",
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    capture_pageview: false,
    capture_pageleave: false,
    before_send: (event) => {
      captured = config.posthog.config.before_send(event);
      return null;
    },
  });
  analytics.clear_opt_in_out_capturing();
  try {
    analytics.capture("$snapshot", { $snapshot_data: events });
    return JSON.stringify(captured);
  } finally {
    analytics.opt_out_capturing();
  }
}
