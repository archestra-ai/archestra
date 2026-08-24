import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoadingState } from "./loading";

describe("LoadingState", () => {
  it("renders a theme-aware generic indicator from the shared component", () => {
    const { container } = render(<LoadingState label="Loading connectors…" />);

    expect(
      screen.getByRole("status", { name: "Loading connectors…" }),
    ).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".animate-spin")).toHaveClass(
      "border-t-muted-foreground",
      "motion-reduce:animate-none",
    );
  });

  it("uses one indicator size while centering viewport and page loading states", () => {
    const { rerender } = render(<LoadingState variant="viewport" />);

    const status = screen.getByRole("status");
    expect(status).toHaveClass("min-h-app-viewport");
    expect(status.querySelector("span")).toHaveClass("size-8");

    rerender(<LoadingState variant="page" />);

    expect(status).toHaveClass(
      "min-h-[calc(var(--visual-viewport-height,100dvh)-12rem)]",
      "items-center",
      "justify-center",
    );
    expect(status.querySelector("span")).toHaveClass("size-8");
  });

  it("keeps inline loading states compact and accessible", () => {
    render(<LoadingState label="Loading token" variant="inline" />);

    const status = screen.getByRole("status", { name: "Loading token" });
    expect(status).toHaveClass("inline-flex", "min-h-0");
    expect(screen.queryByText("Loading token")).toBeNull();
  });
});
