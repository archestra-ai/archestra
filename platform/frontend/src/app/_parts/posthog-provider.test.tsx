import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config/config";
import { PostHogProviderWrapper } from "./posthog-provider";

const { mockIdentify, mockInit, mockReset } = vi.hoisted(() => ({
  mockIdentify: vi.fn(),
  mockInit: vi.fn(),
  mockReset: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    identify: mockIdentify,
    init: mockInit,
    reset: mockReset,
  },
}));

vi.mock("posthog-js/react", () => ({
  PostHogProvider: ({
    children,
  }: {
    children: React.ReactNode;
    client: unknown;
  }) => <>{children}</>,
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
  },
}));

describe("PostHogProviderWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeSessionResult = ({
    data,
    isPending = false,
  }: {
    data: unknown;
    isPending?: boolean;
  }) =>
    ({
      data,
      isPending,
      isRefetching: false,
      error: null,
      refetch: vi.fn(),
    }) as unknown as ReturnType<typeof authClient.useSession>;

  it("initializes PostHog and identifies the authenticated user", async () => {
    vi.mocked(authClient.useSession).mockReturnValue(
      makeSessionResult({
        data: {
          user: {
            id: "user-123",
            email: "user@example.com",
            name: "Example User",
          },
          session: { id: "session-123" },
        },
      }),
    );

    render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(mockIdentify).toHaveBeenCalledWith("user-123", {
        email: "user@example.com",
        name: "Example User",
      });
    });
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("does not identify the same user again when session data refreshes", async () => {
    let sessionData: unknown = {
      user: {
        id: "user-123",
        email: "user@example.com",
        name: "Example User",
      },
      session: { id: "session-123" },
    };

    vi.mocked(authClient.useSession).mockImplementation(() =>
      makeSessionResult({ data: sessionData }),
    );

    const { rerender } = render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockIdentify).toHaveBeenCalledTimes(1);
    });

    sessionData = {
      user: {
        id: "user-123",
        email: "user@example.com",
        name: "Example User",
      },
      session: { id: "session-123" },
    };

    rerender(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockIdentify).toHaveBeenCalledTimes(1);
    });
  });

  it("identifies a different user after the session switches accounts", async () => {
    let sessionData: unknown = {
      user: {
        id: "user-123",
        email: "user@example.com",
        name: "Example User",
      },
      session: { id: "session-123" },
    };

    vi.mocked(authClient.useSession).mockImplementation(() =>
      makeSessionResult({ data: sessionData }),
    );

    const { rerender } = render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockIdentify).toHaveBeenCalledWith("user-123", {
        email: "user@example.com",
        name: "Example User",
      });
    });

    sessionData = {
      user: {
        id: "user-456",
        email: "other@example.com",
        name: "Other User",
      },
      session: { id: "session-456" },
    };

    rerender(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockIdentify).toHaveBeenCalledTimes(2);
      expect(mockIdentify).toHaveBeenLastCalledWith("user-456", {
        email: "other@example.com",
        name: "Other User",
      });
    });
  });

  it("uses the email as the fallback name when the user has no display name", async () => {
    vi.mocked(authClient.useSession).mockReturnValue(
      makeSessionResult({
        data: {
          user: {
            id: "user-123",
            email: "user@example.com",
            name: "",
          },
          session: { id: "session-123" },
        },
      }),
    );

    render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockIdentify).toHaveBeenCalledWith("user-123", {
        email: "user@example.com",
        name: "user@example.com",
      });
    });
  });

  it("resets PostHog after an identified user logs out", async () => {
    let sessionData: unknown = {
      user: {
        id: "user-123",
        email: "user@example.com",
        name: "Example User",
      },
      session: { id: "session-123" },
    };

    vi.mocked(authClient.useSession).mockImplementation(() =>
      makeSessionResult({ data: sessionData }),
    );

    const { rerender } = render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockIdentify).toHaveBeenCalledTimes(1);
    });

    sessionData = null;

    rerender(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockReset).toHaveBeenCalledTimes(1);
    });
  });

  it("does nothing when analytics is disabled", async () => {
    const enabledDescriptor = Object.getOwnPropertyDescriptor(
      config.posthog,
      "enabled",
    );

    try {
      Object.defineProperty(config.posthog, "enabled", {
        configurable: true,
        value: false,
      });

      vi.mocked(authClient.useSession).mockReturnValue(
        makeSessionResult({
          data: {
            user: {
              id: "user-123",
              email: "user@example.com",
              name: "Example User",
            },
            session: { id: "session-123" },
          },
        }),
      );

      render(
        <PostHogProviderWrapper>
          <div>child</div>
        </PostHogProviderWrapper>,
      );

      await waitFor(() => {
        expect(mockInit).not.toHaveBeenCalled();
      });
      expect(mockIdentify).not.toHaveBeenCalled();
      expect(mockReset).not.toHaveBeenCalled();
    } finally {
      if (enabledDescriptor) {
        Object.defineProperty(config.posthog, "enabled", enabledDescriptor);
      }
    }
  });

  it("does not reset PostHog while the auth session is still loading", async () => {
    vi.mocked(authClient.useSession).mockReturnValue(
      makeSessionResult({
        data: null,
        isPending: true,
      }),
    );

    render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockInit).toHaveBeenCalledTimes(1);
    });
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });
});
