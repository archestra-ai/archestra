import { fireEvent, render, screen } from "@testing-library/react";
import { OAuthCallbackStatus } from "./oauth-callback-status";

describe("OAuthCallbackStatus", () => {
  it("explains the secure handoff while the connection is completing", () => {
    render(<OAuthCallbackStatus status="processing" phase="completing" />);

    expect(screen.getByText("Finishing OAuth Connection")).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Completing OAuth authentication" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Securing credentials and connecting the MCP server"),
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

    expect(screen.getByText("Connection Not Completed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The authorization request was declined.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go Back" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
