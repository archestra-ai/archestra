import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingState } from "./loading";

describe("LoadingState", () => {
  it("renders a theme-aware mascot pair from the shared loading component", () => {
    const { container } = render(<LoadingState label="Loading connectors…" />);

    expect(
      screen.getByRole("status", { name: "Loading connectors…" }),
    ).toBeVisible();
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveClass("dark:hidden");
    expect(images[1]).toHaveClass("hidden", "dark:block");
    expect(
      images[0].getAttribute("src")?.replace("-light.gif", "-dark.gif"),
    ).toBe(images[1].getAttribute("src"));
    expect(images[0]).toHaveAttribute("src", expect.stringMatching(/\.gif$/));
  });

  it("uses one mascot size while centering viewport and page loading states", () => {
    const { rerender } = render(<LoadingState variant="viewport" />);

    const status = screen.getByRole("status");
    expect(status).toHaveClass("min-h-app-viewport");
    expect(status.querySelector("span")).toHaveStyle({
      height: "75px",
      width: "75px",
    });

    rerender(<LoadingState variant="page" />);

    expect(status).toHaveClass(
      "min-h-[calc(var(--visual-viewport-height,100dvh)-12rem)]",
      "items-center",
      "justify-center",
    );
    expect(status.querySelector("span")).toHaveStyle({
      height: "75px",
      width: "75px",
    });
  });

  it("keeps inline loading states compact and accessible", () => {
    render(<LoadingState label="Loading token" variant="inline" />);

    const status = screen.getByRole("status", { name: "Loading token" });
    expect(status).toHaveClass("inline-flex", "min-h-0");
    expect(screen.queryByText("Loading token")).toBeNull();
  });
});
