import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateProfile, useUpdateProfile } from "@/lib/agent.query";
import { isReportedApiError } from "@/lib/utils";

// Partial: `@/consts` (pulled in by agent.query.ts) reads real exports of this
// module at import time, so only the two SDK calls under test are replaced.
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      createAgent: vi.fn(),
      updateAgent: vi.fn(),
    },
  };
});

vi.mock("sonner");

const sdk = vi.mocked(archestraApiSdk);

function setup<T>(hook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(hook, { wrapper });
}

const refused = {
  data: undefined,
  error: {
    error: {
      message: "Environment is restricted",
      type: "api_authorization_error",
    },
  },
};

describe("agent write mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Resolving `undefined` on a refused write made a failure look like a save
  // that returned nothing: the form went on to toast success, fire `onCreated`,
  // and run its follow-up writes against an agent that was never created.
  it("rejects when the create is refused", async () => {
    sdk.createAgent.mockResolvedValue(refused as never);

    const { result } = setup(() => useCreateProfile());

    await expect(
      result.current.mutateAsync({ name: "New", agentType: "agent" } as never),
    ).rejects.toThrow(/environment is restricted/i);
  });

  it("rejects when the update is refused", async () => {
    sdk.updateAgent.mockResolvedValue(refused as never);

    const { result } = setup(() => useUpdateProfile());

    await expect(
      result.current.mutateAsync({ id: "agent-1", data: { name: "New" } }),
    ).rejects.toThrow(/environment is restricted/i);
  });

  // The mutation toasts the refusal on its way out. A caller that also toasts
  // its own orchestration failures needs to tell the two apart, or the user
  // reads one refusal twice.
  it("marks the refusal as one the user has already been shown", async () => {
    sdk.updateAgent.mockResolvedValue(refused as never);

    const { result } = setup(() => useUpdateProfile());

    const error = await result.current
      .mutateAsync({ id: "agent-1", data: { name: "New" } })
      .catch((thrown: unknown) => thrown);

    expect(isReportedApiError(error)).toBe(true);
    expect(isReportedApiError(new Error("Environment is restricted"))).toBe(
      false,
    );
  });

  it("still resolves the created agent on success", async () => {
    sdk.createAgent.mockResolvedValue({
      data: { id: "agent-1", name: "New" },
      error: undefined,
    } as never);

    const { result } = setup(() => useCreateProfile());

    await expect(
      result.current.mutateAsync({ name: "New", agentType: "agent" } as never),
    ).resolves.toMatchObject({ id: "agent-1" });
  });

  it("shows a caller-specific message after an update succeeds", async () => {
    sdk.updateAgent.mockResolvedValue({
      data: { id: "agent-1", systemPrompt: "New prompt" },
      error: undefined,
    } as never);

    const { result } = setup(() =>
      useUpdateProfile({ successMessage: "System prompt saved" }),
    );

    await result.current.mutateAsync({
      id: "agent-1",
      data: { systemPrompt: "New prompt" },
    });

    expect(toast.success).toHaveBeenCalledWith("System prompt saved");
  });
});
