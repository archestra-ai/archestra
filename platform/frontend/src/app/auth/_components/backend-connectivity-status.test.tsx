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
    expect(screen.queryByText("Connecting to Server")).not.toBeInTheDocument();
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

    expect(screen.getByText("Connecting to Server")).toBeInTheDocument();
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
      screen.getByText(/Still trying to connect \(attempt 3\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/5s elapsed/)).toBeInTheDocument();
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

    expect(
      screen.getByText(/The server is still starting up/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Network connectivity issues/)).toBeInTheDocument();
    expect(
      screen.getByText(/The server is experiencing problems/),
    ).toBeInTheDocument();
  });

  it("should show help text in unreachable view", () => {
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

    expect(
      screen.getByText(
        /please check your server logs or contact your administrator/i,
      ),
    ).toBeInTheDocument();
  });

  it("should not show elapsed time when 0 seconds", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 1,
      elapsedMs: 500, // Less than 1 second
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(
      screen.getByText(/Still trying to connect \(attempt 1\)/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
  });

  it("should show elapsed time when greater than 0 seconds", () => {
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connecting",
      attemptCount: 2,
      elapsedMs: 3500,
      retry: mockRetry,
    });

    render(
      <BackendConnectivityStatus>
        <div>Login Form</div>
      </BackendConnectivityStatus>,
    );

    expect(screen.getByText(/3s elapsed/)).toBeInTheDocument();
  });
});
