import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetFrontendDocsUrl = vi.fn();

vi.mock("@/components/editor", () => ({
  Editor: () => <div data-testid="editor" />,
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
});
