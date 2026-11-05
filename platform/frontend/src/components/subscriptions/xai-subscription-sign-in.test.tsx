import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startDeviceFlow, pollDeviceFlow } = vi.hoisted(() => ({
  startDeviceFlow: vi.fn(),
  pollDeviceFlow: vi.fn(),
}));

vi.mock("@/lib/xai-subscription-auth.query", () => ({
  useStartXaiSubscriptionDeviceFlow: () => ({
    isPending: false,
    mutateAsync: startDeviceFlow,
  }),
  usePollXaiSubscriptionDeviceFlow: () => ({
    mutateAsync: pollDeviceFlow,
  }),
}));

import { XaiSubscriptionSignIn } from "./xai-subscription-sign-in";

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("XaiSubscriptionSignIn persistence handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startDeviceFlow.mockReset().mockResolvedValue({
      deviceCode: "device-1",
      userCode: "CODE-1",
      verificationUri: "https://accounts.x.ai/device",
      interval: 5,
      expiresIn: 900,
    });
    pollDeviceFlow.mockReset().mockResolvedValue({
      status: "complete",
      credential: "xai-subscription:encoded",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show linked until the credential callback resolves", async () => {
    let resolveSave: (() => void) | undefined;
    const onCredential = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<XaiSubscriptionSignIn onCredential={onCredential} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Grok" }));
    await flushMicrotasks();
    act(() => vi.advanceTimersByTime(5_000));
    await flushMicrotasks();

    expect(onCredential).toHaveBeenCalledWith("xai-subscription:encoded");
    expect(screen.queryByText(/Grok account linked/)).not.toBeInTheDocument();

    await act(async () => resolveSave?.());
    expect(screen.getByText(/Grok account linked/)).toBeInTheDocument();
  });

  it("returns to a retryable sign-in when credential persistence fails", async () => {
    const onCredential = vi.fn().mockRejectedValue(new Error("save failed"));
    render(<XaiSubscriptionSignIn onCredential={onCredential} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Grok" }));
    await flushMicrotasks();
    act(() => vi.advanceTimersByTime(5_000));
    await flushMicrotasks();

    expect(screen.queryByText(/Grok account linked/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with Grok" }),
    ).toBeEnabled();
  });
});
