import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BackendConnectivityStatus } from "./backend-connectivity-status";

// Mock the hook
vi.mock("@/lib/backend-connectivity", () => ({
  useBackendConnectivity: vi.fn(),
}));

import { useBackendConnectivity } from "@/lib/backend-connectivity";

describe("BackendConnectivityStatus", () => {
  const mockRetry = vi.fn();

  it("should render children when status is connected", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 0,
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

  it("should show retry count when there are failed attempts", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 3,
      elapsedMs: 5000,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(
      screen.getByText(/Still trying to connect, attempt 3/),
    ).toBeInTheDocument();
  });

  it("should show unreachable view when status is unreachable", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "unreachable",
      attemptCount: 5,
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
});
