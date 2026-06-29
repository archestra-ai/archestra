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
  }: {
    children: string;
    customStyle?: React.CSSProperties;
    codeTagProps?: React.HTMLAttributes<HTMLElement>;
  }) => (
    <pre data-testid="syntax-highlighter" style={customStyle}>
      <code {...codeTagProps}>{children}</code>
    </pre>
  ),
}));

vi.mock("react-syntax-highlighter/dist/esm/styles/prism", () => ({
  oneDark: {},
  oneLight: {},
}));

import { CodeBlock, CodeBlockCopyButton } from "./code-block";

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("CodeBlock", () => {
  it("applies custom content spacing for overlay actions", () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });

    render(
      <CodeBlock
        code={`curl https://example.com`}
        language="bash"
        contentStyle={{ paddingTop: "2.75rem", paddingRight: "5rem" }}
      />,
    );

    expect(screen.getByTestId("syntax-highlighter")).toHaveStyle({
      paddingTop: "2.75rem",
      paddingRight: "5rem",
    });
  });

  it("copies the rendered code via the built-in copy button", async () => {
    mockUseTheme.mockReturnValue({ resolvedTheme: "light" });
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);

    render(
      <CodeBlock code={`{"hello":"world"}`} language="json">
        <CodeBlockCopyButton />
      </CodeBlock>,
    );

    await user.click(screen.getByRole("button", { name: "Copy to clipboard" }));

    expect(writeText).toHaveBeenCalledWith(`{"hello":"world"}`);
  });
});
