import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startDeviceFlow, pollDeviceFlow } = vi.hoisted(() => ({
  startDeviceFlow: vi.fn(),
  pollDeviceFlow: vi.fn(),
}));

vi.mock("@/lib/openai-codex-auth.query", () => ({
  useStartOpenaiCodexDeviceFlow: () => ({
    isPending: false,
    mutateAsync: startDeviceFlow,
  }),
  usePollOpenaiCodexDeviceFlow: () => ({
    mutateAsync: pollDeviceFlow,
  }),
}));

import { OpenaiCodexSignIn } from "./openai-codex-sign-in";

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("OpenaiCodexSignIn persistence handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startDeviceFlow.mockReset().mockResolvedValue({
      deviceAuthId: "device-1",
      userCode: "CODE-1",
      verificationUri: "https://auth.openai.com/codex/device",
      interval: 5,
      expiresIn: 900,
    });
    pollDeviceFlow.mockReset().mockResolvedValue({
      status: "complete",
      credential: "chatgpt-oauth:encoded",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show linked until credential persistence resolves", async () => {
    let resolveSave: (() => void) | undefined;
    const onCredential = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<OpenaiCodexSignIn onCredential={onCredential} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    );
    await flushMicrotasks();
    act(() => vi.advanceTimersByTime(5_000));
    await flushMicrotasks();

    expect(onCredential).toHaveBeenCalledWith("chatgpt-oauth:encoded");
    expect(
      screen.queryByText(/ChatGPT account linked/),
    ).not.toBeInTheDocument();

    await act(async () => resolveSave?.());
    expect(screen.getByText(/ChatGPT account linked/)).toBeInTheDocument();
  });

  it("returns to a retryable sign-in when credential persistence fails", async () => {
    const onCredential = vi.fn().mockRejectedValue(new Error("save failed"));
    render(<OpenaiCodexSignIn onCredential={onCredential} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    );
    await flushMicrotasks();
    act(() => vi.advanceTimersByTime(5_000));
    await flushMicrotasks();

    expect(
      screen.queryByText(/ChatGPT account linked/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeEnabled();
  });
});
