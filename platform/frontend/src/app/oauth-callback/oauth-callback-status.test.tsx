import { fireEvent, render, screen } from "@testing-library/react";
import { OAuthCallbackStatus } from "./oauth-callback-status";

describe("OAuthCallbackStatus", () => {
  it("explains the secure handoff while the connection is completing", () => {
    render(<OAuthCallbackStatus status="processing" phase="completing" />);

    expect(
      screen.getByRole("heading", { name: "Finishing the connection" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Authorization received")).toBeInTheDocument();
    expect(screen.getByText("Securing credentials")).toBeInTheDocument();
    expect(screen.getByText("Connecting MCP server")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "OAuth connection in progress" }),
    ).toBeInTheDocument();
  });

  it("shows the provider error and returns through the supplied action", () => {
    const onAction = vi.fn();

    render(
      <OAuthCallbackStatus
        status="error"
        errorTitle="OAuth authentication failed"
        errorDescription="The authorization request was declined."
        actionLabel="Go Back"
        onAction={onAction}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "We couldn't finish the connection",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Authorization not completed")).toBeInTheDocument();
    expect(screen.getByText("Credentials unchanged")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The authorization request was declined.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
