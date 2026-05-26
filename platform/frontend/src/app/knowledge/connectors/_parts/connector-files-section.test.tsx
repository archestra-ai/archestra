import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FileStatusBadge } from "./connector-files-section";

describe("FileStatusBadge", () => {
  it("shows a helpful tooltip for failed embedding errors", async () => {
    const user = userEvent.setup();

    render(
      <FileStatusBadge
        embeddingStatus="failed"
        embeddingError="authentication_failed"
      />,
    );

    await user.hover(screen.getByText("Failed"));

    expect(
      await screen.findAllByText(
        "Embedding provider rejected the configured API key or permissions.",
      ),
    ).not.toHaveLength(0);
  });

  it("falls back to a generic tooltip when no embedding error is provided", async () => {
    const user = userEvent.setup();

    render(<FileStatusBadge embeddingStatus="failed" />);

    await user.hover(screen.getByText("Failed"));

    expect(
      await screen.findAllByText(
        "Embedding failed. Check the embedding provider configuration and retry.",
      ),
    ).not.toHaveLength(0);
  });
});
