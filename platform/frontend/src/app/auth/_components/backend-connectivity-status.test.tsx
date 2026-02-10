import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BackendConnectivityStatus } from "./backend-connectivity-status";

// Mock the hooks
vi.mock("@/lib/backend-connectivity", () => ({
  useBackendConnectivity: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

import { useSearchParams } from "next/navigation";
import { useBackendConnectivity } from "@/lib/backend-connectivity";

describe("BackendConnectivityStatus", () => {
  const mockRetry = vi.fn();

  it("should render nothing when status is initializing", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "initializing",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      retry: mockRetry,
    });

    const { container } = render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).not.toBeInTheDocument();
  });

  it("should render nothing when status is checking (first health check in progress)", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "checking",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      retry: mockRetry,
    });

    const { container } = render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    // Should not show any UI during the first health check to avoid flashing
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).not.toBeInTheDocument();
  });

  it("should render children when status is connected", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByTestId("child-content")).toBeInTheDocument();
    expect(screen.queryByText("Connecting...")).not.toBeInTheDocument();
  });

  it("should show connecting view when status is connecting with no attempts", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText("Connecting...")).toBeInTheDocument();
    expect(screen.getByText("Attempting to connect...")).toBeInTheDocument();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("should show retry count with estimated total when there are failed attempts", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 3,
      estimatedTotalAttempts: 7,
      elapsedMs: 5000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(
      screen.getByText(/Still trying to connect, attempt 3 \/ 7/),
    ).toBeInTheDocument();
  });

  it("should show unreachable view when status is unreachable", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
      estimatedTotalAttempts: 7,
      elapsedMs: 60000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText("Unable to Connect")).toBeInTheDocument();
    expect(screen.getByText("Server Unreachable")).toBeInTheDocument();
    expect(
      screen.getByText(/The backend server is not responding/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("should call retry when Try Again button is clicked", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
      estimatedTotalAttempts: 7,
      elapsedMs: 60000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    const retryButton = screen.getByRole("button", { name: /Try Again/i });
    fireEvent.click(retryButton);

    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it("should display possible causes in unreachable view", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
      estimatedTotalAttempts: 7,
      elapsedMs: 60000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText(/Server is still starting up/)).toBeInTheDocument();
    expect(screen.getByText(/Network connectivity issue/)).toBeInTheDocument();
    expect(
      screen.getByText(/Server configuration problem/),
    ).toBeInTheDocument();
  });

  it("should show GitHub issues button in unreachable view", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
      estimatedTotalAttempts: 7,
      elapsedMs: 60000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText("Report issue on GitHub")).toBeInTheDocument();
  });

  it("should show GitHub issues button when there are attempts", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 1,
      estimatedTotalAttempts: 7,
      elapsedMs: 500,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(
      screen.getByText(/Still trying to connect, attempt 1/),
    ).toBeInTheDocument();
    expect(screen.getByText("Report issue on GitHub")).toBeInTheDocument();
  });

  it("should not show GitHub issues button on first attempt", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 3500,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(
      screen.queryByText("Report issue on GitHub"),
    ).not.toBeInTheDocument();
  });

  it("should show Connected message after recovering from connection issues", async () => {
    // Start with connection issues
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3000,
      retry: mockRetry,
    });

    const { rerender } = render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    // Should show connecting view
    expect(screen.getByText("Connecting...")).toBeInTheDocument();

    // Now connection succeeds
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3500,
      retry: mockRetry,
    });

    rerender(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    // Should show "Connected" message
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByText("Successfully connected to the backend server."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("child-content")).not.toBeInTheDocument();
  });

  it("should show refreshing message when redirectTo param is present after connection recovery", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("redirectTo=/agents") as unknown as ReturnType<
        typeof useSearchParams
      >,
    );

    // Start with connection issues
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3000,
      retry: mockRetry,
    });

    const { rerender } = render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    // Now connection succeeds
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 2,
      estimatedTotalAttempts: 7,
      elapsedMs: 3500,
      retry: mockRetry,
    });

    rerender(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    // Should show refreshing message since there's a redirectTo param
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Refreshing...")).toBeInTheDocument();
  });

  it("should render children directly when connected without prior issues", () => {
    // First render with connected status (no prior connection issues)
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 100,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div data-testid="child-content">Login Form</div>
      </BackendConnectivityStatus>,
    );

    // Should render children directly without showing "Connected" message
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });
});
