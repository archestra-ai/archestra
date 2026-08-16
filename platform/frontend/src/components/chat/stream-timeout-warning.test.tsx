import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StreamTimeoutWarning } from "./stream-timeout-warning";

describe("StreamTimeoutWarning", () => {
  it("stays out of the way until the transport stalls", () => {
    const { rerender } = render(<StreamTimeoutWarning isStalled={false} />);
    expect(screen.queryByText(/no stream activity/i)).not.toBeInTheDocument();

    rerender(<StreamTimeoutWarning isStalled />);
    expect(screen.getByText(/no stream activity/i)).toHaveTextContent(
      "The connection may have stalled",
    );
    expect(
      screen.getByRole("link", { name: /learn more/i }),
    ).toBeInTheDocument();
  });

  it("never claims the response itself stalled — that case is reported inline", () => {
    render(<StreamTimeoutWarning isStalled />);
    expect(screen.queryByText(/no response progress/i)).not.toBeInTheDocument();
  });
});
