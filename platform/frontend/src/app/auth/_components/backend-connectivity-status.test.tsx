import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackendConnectivityStatus } from "./backend-connectivity-status";

vi.mock("@/components/app-logo", () => ({
  AppLogo: () => <div data-testid="app-logo" />,
}));

vi.mock("@/lib/config/backend-connectivity", () => ({
  useBackendConnectivity: vi.fn(),
}));

vi.mock("@/lib/hooks/use-app-name");
vi.mock("next/navigation");

import { useSearchParams } from "next/navigation";
import { useBackendConnectivity } from "@/lib/config/backend-connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";

describe("BackendConnectivityStatus", () => {
  const mockRetry = vi.fn();

  beforeEach(() => {
    mockRetry.mockReset();
    vi.mocked(useAppName).mockReturnValue("Sparky");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it.each([
    "initializing",
    "checking",
  ] as const)("renders nothing while status is %s", (status) => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status,
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    const { container } = render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("renders children immediately when connected", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByTestId("child-content")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("shows when the next automatic retry will run", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      nextRetryInMs: 8000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Connecting to Sparky")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The backend is not responding yet. Sign-in will appear when it is ready.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Retrying automatically")).toBeInTheDocument();
    expect(screen.getByText("Next retry in 8s")).toBeInTheDocument();
    expect(screen.queryByText(/Attempt \d/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("keeps retry counters out of the interface", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 3,
      estimatedTotalAttempts: 7,
      elapsedMs: 5000,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText("Retrying automatically")).toBeInTheDocument();
    expect(screen.getByText("Checking now")).toBeInTheDocument();
    expect(screen.queryByText(/Attempt \d/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Report issue/i }),
    ).not.toBeInTheDocument();
  });

  it("shows concise recovery actions when the backend is unavailable", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
      estimatedTotalAttempts: 7,
      elapsedMs: 60000,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Backend unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The Sparky backend did not respond. Check that it is running, then try again.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Report issue" })).toHaveAttribute(
      "href",
      expect.stringMatching(/\/issues$/),
    );
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("retries immediately when requested", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
      estimatedTotalAttempts: 7,
      elapsedMs: 60000,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("confirms recovery before continuing to sign in", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3000,
      nextRetryInMs: 1000,
      retry: mockRetry,
    });

    const { rerender } = render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3500,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    rerender(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Continuing to sign in.")).toBeInTheDocument();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("confirms recovery before reloading an intended destination", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("redirectTo=/agents") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3000,
      nextRetryInMs: 1000,
      retry: mockRetry,
    });

    const { rerender } = render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3500,
      nextRetryInMs: null,
      retry: mockRetry,
    });

    rerender(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Reloading the page.")).toBeInTheDocument();
  });
});
