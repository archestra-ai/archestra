import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("react-syntax-highlighter", () => ({
  Prism: ({
    children,
    customStyle,
    codeTagProps,
    wrapLongLines,
  }: {
    children: string;
    customStyle?: React.CSSProperties;
    codeTagProps?: React.HTMLAttributes<HTMLElement>;
    wrapLongLines?: boolean;
  }) => (
    <pre
      data-testid="syntax-highlighter"
      data-wrap-long-lines={wrapLongLines ? "true" : "false"}
      style={customStyle}
    >
      <code {...codeTagProps}>{children}</code>
    </pre>
  ),
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/prism", () => ({
  oneDark: {},
  oneLight: {},
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { JsonCodeBlock } from "./json-code-block";

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("JsonCodeBlock", () => {
  it("renders formatted JSON with copy padding but no fake top row", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(<JsonCodeBlock value={{ hello: "world" }} />);

    expect(screen.getByText(/"hello": "world"/)).toBeInTheDocument();
    expect(screen.getByTestId("syntax-highlighter")).toHaveStyle({
      paddingRight: "3.5rem",
    });
    expect(screen.getByTestId("syntax-highlighter")).not.toHaveStyle({
      paddingTop: "2.75rem",
    });
    expect(screen.getByTestId("syntax-highlighter")).toHaveAttribute(
      "data-wrap-long-lines",
      "true",
    );
  });

  it("copies the formatted JSON", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(<JsonCodeBlock value={{ hello: "world" }} />);

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith('{\n  "hello": "world"\n}');
  });
});
