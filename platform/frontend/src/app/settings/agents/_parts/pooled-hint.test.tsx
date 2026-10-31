import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PooledHint } from "./pooled-hint";

describe("PooledHint", () => {
  it("keeps the hint open while focus moves onto its Learn more link, and closes it when focus leaves", async () => {
    const user = userEvent.setup();
    render(<PooledHint />);
    const trigger = screen.getByRole("button", { name: "About pooled tiers" });
    await user.hover(trigger);
    const hint = await screen.findByRole("tooltip");
    expect(hint).toHaveTextContent(
      "Agent runs start much quicker from pool of runtime instances. Managed automatically. Pooled instances reserve part of cluster's capacity. Learn more",
    );
    const [link] = screen.getAllByRole("link", { name: /Learn more/ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringMatching(/\/docs\/agents\/runtime\/setup#warm-pools$/),
    );

    // A press on the link takes focus from the icon: the hint must not close
    // under the pointer.
    fireEvent.blur(trigger, { relatedTarget: link });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.blur(trigger, { relatedTarget: document.body });
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
  });
});
