import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "./message-actions";

describe("MessageActions feedback", () => {
  it("renders no thumbs buttons without onFeedbackChange", () => {
    render(<MessageActions textToCopy="text" />);

    expect(
      screen.queryByRole("button", { name: "Good response" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Bad response" }),
    ).not.toBeInTheDocument();
  });

  it("reports thumbs up and down clicks", async () => {
    const user = userEvent.setup();
    const onFeedbackChange = vi.fn();
    render(
      <MessageActions
        textToCopy="text"
        feedback={null}
        onFeedbackChange={onFeedbackChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Good response" }));
    expect(onFeedbackChange).toHaveBeenLastCalledWith("up");

    await user.click(screen.getByRole("button", { name: "Bad response" }));
    expect(onFeedbackChange).toHaveBeenLastCalledWith("down");
  });

  it("clears when the selected thumb is clicked again and exposes selection via aria-pressed", async () => {
    const user = userEvent.setup();
    const onFeedbackChange = vi.fn();
    render(
      <MessageActions
        textToCopy="text"
        feedback="up"
        onFeedbackChange={onFeedbackChange}
      />,
    );

    const thumbsUp = screen.getByRole("button", { name: "Good response" });
    const thumbsDown = screen.getByRole("button", { name: "Bad response" });
    expect(thumbsUp).toHaveAttribute("aria-pressed", "true");
    expect(thumbsDown).toHaveAttribute("aria-pressed", "false");

    await user.click(thumbsUp);
    expect(onFeedbackChange).toHaveBeenLastCalledWith(null);

    await user.click(thumbsDown);
    expect(onFeedbackChange).toHaveBeenLastCalledWith("down");
  });

  it("disables both thumbs while a feedback request is pending", () => {
    render(
      <MessageActions
        textToCopy="text"
        feedback={null}
        onFeedbackChange={vi.fn()}
        feedbackDisabled
      />,
    );

    expect(
      screen.getByRole("button", { name: "Good response" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bad response" })).toBeDisabled();
  });
});
