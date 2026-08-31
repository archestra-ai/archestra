import { render, screen, waitFor, within } from "@testing-library/react";
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

    expect(screen.getByText("Handlebars")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "docs(opens in new tab)" }),
    ).toHaveAttribute(
      "href",
      "https://archestra.ai/docs/platform-agents#system-prompt-templating",
    );
  });

  it("hides the Archestra docs link under white-labeling", () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    render(<SystemPromptEditor value="" onChange={vi.fn()} />);

    expect(screen.getByText("Handlebars")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "docs(opens in new tab)" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" && /templating\./.test(el.textContent ?? ""),
      ),
    ).toBeInTheDocument();
  });

  it("keeps the editor at the height it was given, and offers full screen instead of a taller box", () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);

    render(<SystemPromptEditor value="" onChange={vi.fn()} height="120px" />);

    expect(screen.getByRole("textbox", { name: "Instruction" })).toBeVisible();
    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-height",
      "120px",
    );
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /full screen/i }),
    ).toBeInTheDocument();
  });

  it("opens the instruction full screen on the same value, and closes back to the form", async () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <SystemPromptEditor
        title="System prompt"
        value="Hello {{user.name}}"
        onChange={onChange}
        height="120px"
        headerExtra={<button type="button">Reset to Default</button>}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: /full screen/i }));
    const dialog = screen.getByRole("dialog", { name: "System prompt" });
    // The whole viewport: a second editor on the same value, the header's
    // extra action alongside the way back.
    const editors = within(dialog).getAllByTestId("editor");
    expect(editors).toHaveLength(1);
    expect(editors[0]).toHaveValue("Hello {{user.name}}");
    expect(editors[0]).toHaveAttribute("data-height", "100%");
    expect(
      within(dialog).getByRole("button", { name: "Reset to Default" }),
    ).toBeInTheDocument();

    // Typing there is typing in the form.
    await user.type(editors[0], "!");
    expect(onChange).toHaveBeenLastCalledWith("Hello {{user.name}}!");

    await user.click(
      within(dialog).getByRole("button", { name: /exit full screen/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByTestId("editor")).toHaveLength(1);
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

  it("leaves the full-screen editor read-only when the form is", async () => {
    mockGetFrontendDocsUrl.mockReturnValue(null);
    const user = userEvent.setup();

    render(<SystemPromptEditor value="x" onChange={vi.fn()} readOnly />);
    await user.click(screen.getByRole("button", { name: /full screen/i }));
    expect(
      within(screen.getByRole("dialog")).getByTestId("editor"),
    ).toHaveAttribute("readonly");
  });
});
