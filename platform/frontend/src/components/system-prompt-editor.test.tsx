import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetFrontendDocsUrl = vi.fn();
const mockGetVisibleDocsUrl = vi.fn();

vi.mock("@/components/editor");

vi.mock("@/lib/docs/docs", () => ({
  getFrontendDocsUrl: (...args: unknown[]) => mockGetFrontendDocsUrl(...args),
  getVisibleDocsUrl: (...args: unknown[]) => mockGetVisibleDocsUrl(...args),
}));

import { SystemPromptEditor } from "./system-prompt-editor";

/** The sized box around the editor, which is what grows and is dragged. */
const editorBox = () => screen.getByTestId("editor").parentElement;

describe("SystemPromptEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVisibleDocsUrl.mockImplementation((href) => href);
  });

  it("shows the Archestra docs link when available", () => {
    mockGetFrontendDocsUrl.mockReturnValue(
      "https://archestra.ai/docs/platform-agents#system-prompt-templating",
    );

    render(<SystemPromptEditor value="" onChange={vi.fn()} />);

    expect(
      screen.getByRole("link", { name: "docs(opens in new tab)" }),
    ).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/platform-agents#system-prompt-templating",
    );
    // Ours is the only link: sending a reader to handlebarsjs.com answered a
    // question the variables list answers better.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("hides the Archestra docs link under white-labeling", () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    render(<SystemPromptEditor value="" onChange={vi.fn()} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" && /templating\./.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
  });

  it("grows the box to fit the text, between its floor and its ceiling", () => {
    // The mock editor reports 20px a line plus 16px of padding, so the floor
    // holds for a short prompt and the text drives the height past it.
    mockGetFrontendDocsUrl.mockReturnValue(null);

    const { rerender } = render(
      <SystemPromptEditor
        value="one line"
        onChange={vi.fn()}
        minHeight={120}
      />,
    );
    expect(editorBox()).toHaveStyle({ height: "120px" });

    rerender(
      <SystemPromptEditor
        value={Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")}
        onChange={vi.fn()}
        minHeight={120}
      />,
    );
    expect(editorBox()).toHaveStyle({ height: "216px" });

    // Past the ceiling the editor scrolls rather than pushing the form down.
    rerender(
      <SystemPromptEditor
        value={Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")}
        onChange={vi.fn()}
        minHeight={120}
        maxHeight={400}
      />,
    );
    expect(editorBox()).toHaveStyle({ height: "400px" });
  });

  it("offers a resize grip instead of a full-screen dialog", async () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);
    const user = userEvent.setup();

    render(<SystemPromptEditor value="" onChange={vi.fn()} minHeight={120} />);

    expect(screen.queryByRole("button", { name: /full screen/i })).toBeNull();

    // Sizing it by hand is not mouse-only: the grip takes the arrow keys.
    const grip = screen.getByRole("separator", { name: /resize instruction/i });
    grip.focus();
    await user.keyboard("{ArrowDown}");
    expect(editorBox()).toHaveStyle({ height: "144px" });

    // And a dragged box stops following the text.
    await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(editorBox()).toHaveStyle({ height: "120px" });
  });

  it("warns about expressions Handlebars cannot parse", async () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    render(
      <SystemPromptEditor
        value="Hi {{user.name}}, see {{user.*}} for the rest."
        onChange={vi.fn()}
      />,
    );

    // The parser is loaded lazily, so the warning arrives after a tick.
    await waitFor(() =>
      expect(screen.getByText("{{user.*}}")).toBeInTheDocument(),
    );
    // The valid expression is not flagged.
    expect(screen.queryByText("{{user.name}}")).toBeNull();
  });

  it("clears the warning once the expression parses", async () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    const { rerender } = render(
      <SystemPromptEditor value="Hi {{user.*}}" onChange={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByText("{{user.*}}")).toBeInTheDocument(),
    );

    // A valid template — block helpers included — leaves nothing flagged.
    rerender(
      <SystemPromptEditor
        value={'Hi {{user.name}}. {{#includes user.teams "A"}}a{{/includes}}'}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByText("{{user.*}}")).toBeNull());
  });

  it("keeps the editor read-only when the form is", () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    render(<SystemPromptEditor value="x" onChange={vi.fn()} readOnly />);

    expect(screen.getByTestId("editor")).toHaveAttribute("readonly");
  });
});
