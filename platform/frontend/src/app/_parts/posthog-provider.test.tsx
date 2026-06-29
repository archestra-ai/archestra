import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { usePublicConfig } from "@/lib/config/config.query";
import { PostHogProviderWrapper } from "./posthog-provider";

const DEFAULT_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";

const { mockGroup, mockIdentify, mockInit, mockRegister, mockReset } =
  vi.hoisted(() => ({
    mockGroup: vi.fn(),
    mockIdentify: vi.fn(),
    mockInit: vi.fn(),
    mockRegister: vi.fn(),
    mockReset: vi.fn(),
  }));

vi.mock("posthog-js", () => ({
  default: {
    group: mockGroup,
    identify: mockIdentify,
    init: mockInit,
    register: mockRegister,
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

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(),
}));

vi.mock("@/lib/config/config.query", () => ({
  usePublicConfig: vi.fn(),
}));

describe("PostHogProviderWrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({
        enabled: true,
        key: "ph_test_key",
        host: "https://posthog.example.com",
      }),
    );
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
    }) as unknown as ReturnType<typeof useSession>;

  const makePublicConfigResult = ({
    enabled,
    key,
    host,
    instanceId = DEFAULT_INSTANCE_ID,
    isLoading = false,
  }: {
    enabled: boolean;
    key: string;
    host: string;
    instanceId?: string | null;
    isLoading?: boolean;
  }) =>
    ({
      data: isLoading
        ? undefined
        : {
            disableBasicAuth: false,
            disableInvitations: false,
            analytics: {
              enabled,
              instanceId,
              posthog: {
                key,
                host,
              },
            },
          },
      isLoading,
    }) as unknown as ReturnType<typeof usePublicConfig>;

  it("initializes PostHog and identifies the authenticated user", async () => {
    vi.mocked(useSession).mockReturnValue(
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
      expect(mockInit).toHaveBeenCalledWith(
        "ph_test_key",
        expect.objectContaining({
          api_host: "https://posthog.example.com",
        }),
      );
      expect(mockIdentify).toHaveBeenCalledWith("user-123", {
        email: "user@example.com",
        name: "Example User",
      });
      expect(mockRegister).toHaveBeenCalledWith({
        instance_id: DEFAULT_INSTANCE_ID,
      });
      expect(mockGroup).toHaveBeenCalledWith("instance", DEFAULT_INSTANCE_ID);
    });
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("does not register the same instance again when config refreshes", async () => {
    vi.mocked(useSession).mockReturnValue(
      makeSessionResult({
        data: null,
      }),
    );

    const { rerender } = render(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockGroup).toHaveBeenCalledTimes(1);
    });

    rerender(
      <PostHogProviderWrapper>
        <div>child</div>
      </PostHogProviderWrapper>,
    );

    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockGroup).toHaveBeenCalledTimes(1);
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

    vi.mocked(useSession).mockImplementation(() =>
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

    vi.mocked(useSession).mockImplementation(() =>
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
    vi.mocked(useSession).mockReturnValue(
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

    vi.mocked(useSession).mockImplementation(() =>
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
    expect(mockRegister).toHaveBeenCalledTimes(2);
    expect(mockGroup).toHaveBeenCalledTimes(2);
  });

  it("does nothing when analytics is disabled", async () => {
    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({
        enabled: false,
        key: "ph_disabled_key",
        host: "https://posthog.example.com",
      }),
    );

    vi.mocked(useSession).mockReturnValue(
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
    expect(mockGroup).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("does not initialize when analytics is enabled but key is empty", async () => {
    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({
        enabled: true,
        key: "",
        host: "https://posthog.example.com",
      }),
    );

    vi.mocked(useSession).mockReturnValue(
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
    expect(mockGroup).not.toHaveBeenCalled();
    expect(mockIdentify).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("does not reset PostHog while the auth session is still loading", async () => {
    vi.mocked(useSession).mockReturnValue(
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
