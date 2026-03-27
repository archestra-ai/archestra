import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetFrontendDocsUrl = vi.fn();

vi.mock("@/components/editor", () => ({
  Editor: (props: { height?: string }) => (
    <div data-testid="editor" data-height={props.height} />
  ),
}));

vi.mock("@/lib/docs/docs", () => ({
  getFrontendDocsUrl: (...args: unknown[]) => mockGetFrontendDocsUrl(...args),
}));

import { SystemPromptEditor } from "./system-prompt-editor";

describe("SystemPromptEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the Archestra docs link when available", () => {
    mockGetFrontendDocsUrl.mockReturnValue(
      "https://archestra.ai/docs/platform-agents#system-prompt-templating",
    );

    render(<SystemPromptEditor value="" onChange={vi.fn()} />);

    expect(screen.getByText("Handlebars")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/platform-agents#system-prompt-templating",
    );
  });

  it("hides the Archestra docs link under white-labeling", () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    render(<SystemPromptEditor value="" onChange={vi.fn()} />);

    expect(screen.getByText("Handlebars")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "docs" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/templating\./)).toBeInTheDocument();
  });

  it("expands and collapses the shared editor height", async () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);
    const user = userEvent.setup();

    render(<SystemPromptEditor value="" onChange={vi.fn()} height="120px" />);

    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-height",
      "120px",
    );

    await user.click(screen.getByRole("button", { name: /Expand/i }));

    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-height",
      "420px",
    );

    await user.click(screen.getByRole("button", { name: /Collapse/i }));

    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-height",
      "120px",
    );
  });
});
