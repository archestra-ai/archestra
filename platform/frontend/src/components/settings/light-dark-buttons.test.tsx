"use client";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

import { LightDarkButtons } from "./light-dark-buttons";

function setup(
  props: { isLightOnly?: boolean; isDarkOnly?: boolean } = {},
  currentMode: "light" | "dark" = "dark",
) {
  const setTheme = vi.fn();
  mockUseTheme.mockReturnValue({ theme: currentMode, setTheme });
  return { setTheme, ...render(<LightDarkButtons {...props} />) };
}

describe("LightDarkButtons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the active mode button as aria-pressed", () => {
    setup({}, "light");
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("calls setTheme('light') when the Light button is clicked", async () => {
    const { setTheme } = setup();
    await userEvent.click(screen.getByRole("button", { name: /light/i }));
    expect(setTheme).toHaveBeenCalledWith("light");
  });

  it("calls setTheme('dark') when the Dark button is clicked", async () => {
    const { setTheme } = setup({}, "light");
    await userEvent.click(screen.getByRole("button", { name: /dark/i }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("disables the Light button and shows a tooltip when the theme is dark-only", () => {
    setup({ isDarkOnly: true });
    expect(screen.getByRole("button", { name: /light/i })).toBeDisabled();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /only supports dark mode/i,
    );
  });

  it("disables the Dark button and shows a tooltip when the theme is light-only", () => {
    setup({ isLightOnly: true }, "light");
    expect(screen.getByRole("button", { name: /dark/i })).toBeDisabled();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /only supports light mode/i,
    );
  });

  it("forces dark mode when isDarkOnly becomes true", () => {
    const setTheme = vi.fn();
    mockUseTheme.mockReturnValue({ theme: "light", setTheme });
    const { rerender } = render(<LightDarkButtons />);
    setTheme.mockClear();

    rerender(<LightDarkButtons isDarkOnly />);
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(setTheme).toHaveBeenCalledTimes(1);
  });

  it("forces light mode when isLightOnly becomes true", () => {
    const setTheme = vi.fn();
    mockUseTheme.mockReturnValue({ theme: "dark", setTheme });
    const { rerender } = render(<LightDarkButtons />);
    setTheme.mockClear();

    rerender(<LightDarkButtons isLightOnly />);
    expect(setTheme).toHaveBeenCalledWith("light");
    expect(setTheme).toHaveBeenCalledTimes(1);
  });

  it("does not re-correct the mode when setTheme reference changes (no blink)", () => {
    // next-themes creates a new setTheme reference on every mode change.
    // The component must not treat that as a reason to override the user's choice.
    const setTheme = vi.fn();
    mockUseTheme.mockReturnValue({ theme: "dark", setTheme });
    const { rerender } = render(<LightDarkButtons isDarkOnly />);
    setTheme.mockClear();

    const newSetTheme = vi.fn();
    mockUseTheme.mockReturnValue({ theme: "light", setTheme: newSetTheme });
    rerender(<LightDarkButtons isDarkOnly />);

    expect(newSetTheme).not.toHaveBeenCalled();
  });
});
