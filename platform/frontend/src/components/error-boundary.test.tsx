"use client";

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorReporting } from "@/lib/error-reporting";
import { ErrorBoundary } from "./error-boundary";

vi.mock("@/lib/error-reporting", () => ({
  errorReporting: { setUser: vi.fn(), captureException: vi.fn() },
}));

function ThrowingComponent(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("captures client render errors in Sentry", async () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    await waitFor(() => {
      expect(errorReporting.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "boom" }),
        expect.objectContaining({
          extra: expect.objectContaining({
            componentStack: expect.any(String),
          }),
        }),
      );
    });
  });
});
