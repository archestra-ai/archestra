import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

import { ToolInput, ToolOutput } from "./tool";

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("Tool copy actions", () => {
  it("copies serialized tool parameters", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<ToolInput input={{ city: "Toronto", limit: 5 }} />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ city: "Toronto", limit: 5 }, null, 2),
    );
  });

  it("copies the full serialized tool response", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<ToolOutput output={{ result: "ok", count: 42 }} />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ result: "ok", count: 42 }, null, 2),
    );
  });

  it("renders a multi-line string parameter as its own block with the raw value", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<ToolInput input={{ command: "echo hi\necho bye", cwd: "/tmp" }} />);

    // Field names must stay attached to values when a multiline argument
    // switches the request away from its ordinary JSON representation.
    const fields = screen.getAllByRole("term");
    expect(fields.map((field) => field.textContent)).toEqual([
      "command",
      "cwd",
    ]);
    const values = screen.getAllByRole("definition");
    expect(values[0]).toHaveTextContent("echo hi");
    expect(values[1]).toHaveTextContent("/tmp");

    // The raw multiline value is present immediately, even before the lazy
    // highlighter loads and splits the text into separate line elements.
    const command = screen.getAllByRole("region", {
      name: "Code sample, text",
    })[0];
    expect(command.querySelector("code")?.textContent).toBe(
      "echo hi\necho bye",
    );
    expect(screen.queryByText(/\\n/)).not.toBeInTheDocument();

    // the field copy button copies the raw string, not JSON
    await user.click(
      within(values[0]).getByRole("button", { name: "Copy to clipboard" }),
    );

    expect(writeText).toHaveBeenCalledWith("echo hi\necho bye");
    await user.click(
      within(values[1]).getByRole("button", { name: "Copy to clipboard" }),
    );
    expect(writeText).toHaveBeenLastCalledWith("/tmp");
  });

  it("renders MCP tool output using content instead of dumping rawContent metadata", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(
      <ToolOutput
        output={{
          content: "ARCH_TEST = asdfasdfadsf",
          rawContent: [{ type: "text", text: "ARCH_TEST = asdfasdfadsf" }],
          _meta: {
            ignored: true,
          },
        }}
      />,
    );

    expect(screen.getByText("ARCH_TEST = asdfasdfadsf")).toBeInTheDocument();
    expect(screen.queryByText(/rawContent/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith("ARCH_TEST = asdfasdfadsf");
  });
});

describe("ToolOutput for results that are not plain text", () => {
  const TINY_PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("says an empty result is empty, and shows none of the fields it is stored in", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    render(
      <ToolOutput
        label="Result"
        output={{
          _meta: { archestraExecutedAs: { kind: "org" } },
          content: "",
          rawContent: [],
        }}
      />,
    );

    expect(screen.getByText("The tool returned no content.")).toBeVisible();
    expect(screen.queryByText(/_meta|rawContent/)).not.toBeInTheDocument();
  });

  it("shows an image the tool returned, with a marker where it stood in the text", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    render(
      <ToolOutput
        label="Result"
        output={{
          content: "Chart:\n[image]",
          rawContent: [
            { type: "text", text: "Chart:" },
            { type: "image", data: TINY_PNG, mimeType: "image/png" },
          ],
        }}
      />,
    );

    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      `data:image/png;base64,${TINY_PNG}`,
    );
    expect(screen.getByText(/\[image\]/)).toBeVisible();
  });

  it("shows the image of a result stored with its payload in the text, never the payload", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const block = { type: "image", data: TINY_PNG, mimeType: "image/png" };
    render(
      <ToolOutput
        label="Result"
        output={{
          content: `Chart:\n${JSON.stringify(block)}`,
          rawContent: [{ type: "text", text: "Chart:" }, block],
        }}
      />,
    );

    expect(screen.getByRole("img")).toBeVisible();
    expect(screen.queryByText(new RegExp(TINY_PNG.slice(0, 24)))).toBeNull();
    expect(screen.getByText(/\[image\]/)).toBeVisible();
  });

  it("leaves out an image whose payload was stripped or is not a picture format", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    render(
      <ToolOutput
        label="Result"
        output={{
          content: "[image]\n[image]",
          rawContent: [
            {
              type: "image",
              data: "[Image data stripped to save context]",
              mimeType: "image/png",
            },
            { type: "image", data: TINY_PNG, mimeType: "image/svg+xml" },
          ],
        }}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders nothing for a failed call with no result: the error text is shown beside it", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const { container } = render(
      <ToolOutput label="Error" output={undefined} errorText="Timed out" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
