import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { throwOnApiError } from "@/lib/utils/api";
import { QueryLoadError } from "./query-load-error";

describe("QueryLoadError", () => {
  it("renders the given title and calls onRetry when the retry button is clicked", async () => {
    const onRetry = vi.fn();
    render(
      <QueryLoadError title="Custom load error title" onRetry={onRetry} />,
    );

    expect(screen.getByText("Custom load error title")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("exposes the retry button under the provided test id", () => {
    render(
      <QueryLoadError title="t" onRetry={vi.fn()} retryTestId="my-retry-id" />,
    );

    expect(screen.getByTestId("my-retry-id")).toBeInTheDocument();
  });

  it("says a refused request is about access, not the connection, and offers no retry", () => {
    render(
      <QueryLoadError
        title="Couldn't load your plugins"
        error={queryErrorFor("api_authorization_error")}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load your plugins")).toBeInTheDocument();
    expect(
      screen.getByText(
        "You don't have access to this. Ask an admin if you need it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/internet connection/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("asks a signed-out reader to sign in again, not to ask an admin", async () => {
    const onRetry = vi.fn();
    render(
      <QueryLoadError
        title="t"
        error={queryErrorFor("api_authentication_error")}
        onRetry={onRetry}
      />,
    );

    expect(
      screen.getByText("Your session ended. Sign in again to continue."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ask an admin/i)).toBeNull();
    expect(screen.queryByText(/internet connection/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps blaming the connection, with a retry, when the request did not get through", () => {
    render(
      <QueryLoadError
        title="t"
        error={new TypeError("Failed to fetch")}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(/internet connection/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

/** What a query hook throws for the SDK's error response of this type. */
function queryErrorFor(type: string): unknown {
  try {
    throwOnApiError(
      { error: { message: "Refused", type } },
      { toastOnError: false },
    );
  } catch (error) {
    return error;
  }
  throw new Error("throwOnApiError did not throw");
}
