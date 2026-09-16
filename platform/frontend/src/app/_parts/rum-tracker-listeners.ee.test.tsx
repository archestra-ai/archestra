import { act, cleanup, render } from "@testing-library/react";

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let usePathname: typeof import("next/navigation").usePathname;
let useSession: typeof import("@/lib/auth/auth.query").useSession;
let usePublicConfig: typeof import("@/lib/config/config.query").usePublicConfig;

vi.mock("next/navigation");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

// Exercise the real tracker, RUM client and web-vitals library. Only browser
// performance APIs (missing in jsdom), network and query inputs are stubbed.
describe("RUM web-vitals listener lifetime", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ usePathname } = await import("next/navigation"));
    ({ useSession } = await import("@/lib/auth/auth.query"));
    ({ usePublicConfig } = await import("@/lib/config/config.query"));
    vi.useFakeTimers();
    BrowserPerformanceObserver.instances = [];
    vi.stubGlobal("PerformanceObserver", BrowserPerformanceObserver);
    vi.stubGlobal(
      "PerformanceEventTiming",
      class {
        get interactionId() {
          return 1;
        }
      },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    vi.stubGlobal("requestIdleCallback", (callback: () => void) =>
      setTimeout(callback, 0),
    );
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.spyOn(window, "addEventListener");
    vi.spyOn(document, "addEventListener");
    Object.defineProperty(performance, "getEntriesByType", {
      configurable: true,
      value: () => [],
    });
    vi.mocked(usePathname).mockReturnValue("/chat");
    setEnabled(true);
    setSignedIn(true);
  });

  afterEach(() => {
    cleanup();
    for (const target of [window, document]) {
      for (const [type, listener, options] of vi.mocked(target.addEventListener)
        .mock.calls) {
        target.removeEventListener(type, listener, options);
      }
    }
    Reflect.deleteProperty(navigator, "sendBeacon");
    Reflect.deleteProperty(performance, "getEntriesByType");
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "disabled",
    "signed out",
  ])("does not subscribe when %s", async (state) => {
    if (state === "disabled") setEnabled(false);
    else setSignedIn(false);
    const addListener = vi.spyOn(window, "addEventListener");
    const { RumTracker } = await import("./rum-tracker.ee");
    render(<RumTracker />);
    await settle();
    expect(BrowserPerformanceObserver.instances).toHaveLength(0);
    expect(
      addListener.mock.calls.filter(([type]) => type === "pageshow"),
    ).toHaveLength(0);
  });

  it("does not subscribe if sign-out happens while the library is loading", async () => {
    const { RumTracker } = await import("./rum-tracker.ee");
    const view = render(<RumTracker />);
    setSignedIn(false);
    view.rerender(<RumTracker />);
    await settle();
    expect(BrowserPerformanceObserver.instances).toHaveLength(0);
  });

  it("keeps one set of subscriptions across rerenders, remounts and sign-in cycles", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const { RumTracker } = await import("./rum-tracker.ee");
    const view = render(
      <StrictMode>
        <RumTracker />
      </StrictMode>,
    );
    await settle();
    const pageshowCount = () =>
      addListener.mock.calls.filter(([type]) => type === "pageshow").length;
    const initialCount = pageshowCount();
    expect(initialCount).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      vi.mocked(usePathname).mockReturnValue(`/chat/${i}`);
      view.rerender(
        <StrictMode>
          <RumTracker />
        </StrictMode>,
      );
    }
    await settle();
    expect(pageshowCount()).toBe(initialCount);
    setSignedIn(false);
    view.rerender(
      <StrictMode>
        <RumTracker />
      </StrictMode>,
    );
    setSignedIn(true);
    view.rerender(
      <StrictMode>
        <RumTracker />
      </StrictMode>,
    );
    setEnabled(false);
    view.rerender(
      <StrictMode>
        <RumTracker />
      </StrictMode>,
    );
    setEnabled(true);
    view.rerender(
      <StrictMode>
        <RumTracker />
      </StrictMode>,
    );
    view.unmount();
    const { rumClient } = await import("@/lib/rum.ee");
    rumClient.reset();
    render(<RumTracker />);
    await settle();
    expect(pageshowCount()).toBe(initialCount);
  });

  it("reports buffered paint metrics after RUM starts", async () => {
    const { rumClient } = await import("@/lib/rum.ee");
    const report = vi.spyOn(rumClient, "trackWebVital");
    const { RumTracker } = await import("./rum-tracker.ee");
    render(<RumTracker />);
    await settle();
    const paintObservers = BrowserPerformanceObserver.instances.filter(
      (observer) => observer.types.has("paint"),
    );
    expect(paintObservers.length).toBeGreaterThan(0);
    for (const observer of paintObservers) {
      observer.deliver([
        {
          name: "first-contentful-paint",
          startTime: 120,
          entryType: "paint",
          duration: 0,
        } as PerformanceEntry,
      ]);
    }
    await settle();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ name: "FCP", value: 120, rating: "good" }),
    );
  });

  it("does not retain a visibility listener for every keystroke or INP batch", async () => {
    const targets = [window, document].map((target) => ({
      addListener: vi.spyOn(target, "addEventListener"),
      removeListener: vi.spyOn(target, "removeEventListener"),
    }));
    const { RumTracker } = await import("./rum-tracker.ee");
    render(<RumTracker />);
    await settle();
    const retainedVisibilityListeners = () =>
      targets.reduce((count, { addListener, removeListener }) => {
        const active = new Set(
          addListener.mock.calls
            .filter(([type]) => type === "visibilitychange")
            .map(([, listener]) => listener),
        );
        for (const [type, listener] of removeListener.mock.calls) {
          if (type === "visibilitychange") active.delete(listener);
        }
        return count + active.size;
      }, 0);
    const initialCount = retainedVisibilityListeners();
    const eventObservers = BrowserPerformanceObserver.instances.filter(
      (observer) => observer.types.has("event"),
    );
    expect(eventObservers.length).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      for (const observer of eventObservers) {
        observer.deliver([]);
      }
      await settle();
    }
    expect(retainedVisibilityListeners()).toBeLessThanOrEqual(initialCount);
  });
});

function setEnabled(enabled: boolean) {
  vi.mocked(usePublicConfig).mockReturnValue({
    data: { rum: { enabled } },
  } as ReturnType<typeof usePublicConfig>);
}

function setSignedIn(signedIn: boolean) {
  vi.mocked(useSession).mockReturnValue({
    data: signedIn ? { user: { id: "test-user" } } : null,
  } as ReturnType<typeof useSession>);
}

async function settle() {
  await act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(50);
  });
}

class BrowserPerformanceObserver {
  static supportedEntryTypes = [
    "paint",
    "event",
    "first-input",
    "largest-contentful-paint",
    "layout-shift",
  ];
  static instances: BrowserPerformanceObserver[] = [];
  types = new Set<string>();
  constructor(private callback: PerformanceObserverCallback) {
    BrowserPerformanceObserver.instances.push(this);
  }
  observe(options: PerformanceObserverInit) {
    if (options.type) this.types.add(options.type);
  }
  disconnect() {}
  takeRecords() {
    return [];
  }
  deliver(entries: PerformanceEntry[]) {
    this.callback(
      { getEntries: () => entries } as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    );
  }
}
