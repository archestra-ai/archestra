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

import { LightDarkButtons } from "./light-dark-buttons";

function setup(currentMode: "light" | "dark" = "dark") {
  const setTheme = vi.fn();
  mockUseTheme.mockReturnValue({ theme: currentMode, setTheme });
  return { setTheme, ...render(<LightDarkButtons />) };
}

describe("LightDarkButtons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks the active mode button as aria-pressed", () => {
    setup("light");
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
    const { setTheme } = setup("light");
    await userEvent.click(screen.getByRole("button", { name: /dark/i }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});
