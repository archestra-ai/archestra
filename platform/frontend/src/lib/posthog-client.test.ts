import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  stopSessionRecording: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

const interactive = vi.hoisted(() => ({
  release: () => undefined as void,
  gate: Promise.resolve(),
}));
vi.mock("./app-interactive", () => ({
  appInteractive: { whenIdle: () => interactive.gate },
}));

let posthogClient: typeof import("./posthog-client").posthogClient;

describe("posthogClient", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    interactive.gate = new Promise((resolve) => {
      interactive.release = resolve;
    });
    ({ posthogClient } = await import("./posthog-client"));
  });

  it("queues calls made before init and replays them in order after it", async () => {
    posthogClient.run((p) => p.identify("viewer"));
    posthogClient.capture("message_sent", { messageLength: 3 });
    posthogClient.init("ph_key", { api_host: "https://ph.example.com" });
    await Promise.resolve();
    expect(posthog.init).not.toHaveBeenCalled();

    interactive.release();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalledTimes(1));
    expect(posthog.identify).toHaveBeenCalledWith("viewer");
    expect(posthog.capture).toHaveBeenCalledWith("message_sent", {
      messageLength: 3,
    });
    expect(posthog.init.mock.invocationCallOrder[0]).toBeLessThan(
      posthog.identify.mock.invocationCallOrder[0],
    );

    posthogClient.capture("prompt_selected");
    expect(posthog.capture).toHaveBeenLastCalledWith(
      "prompt_selected",
      undefined,
    );
  });

  it("drops the queue and never loads PostHog when analytics is off", async () => {
    posthogClient.capture("message_sent");
    posthogClient.disable();
    posthogClient.capture("message_sent");
    interactive.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("stops capturing and recording when telemetry is turned off while running", async () => {
    posthogClient.init("phc_key", {});
    interactive.release();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());

    posthogClient.disable();
    posthogClient.capture("message_sent");

    expect(posthog.opt_out_capturing).toHaveBeenCalled();
    expect(posthog.stopSessionRecording).toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("never starts PostHog when telemetry is turned off while it loads", async () => {
    posthogClient.init("phc_key", {});
    posthogClient.disable();
    interactive.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("lifts a remembered opt-out when telemetry is on again", async () => {
    posthog.has_opted_out_capturing.mockReturnValueOnce(true);
    posthogClient.init("phc_key", {});
    interactive.release();
    await vi.waitFor(() => expect(posthog.init).toHaveBeenCalled());

    expect(posthog.opt_in_capturing).toHaveBeenCalled();
  });
});
