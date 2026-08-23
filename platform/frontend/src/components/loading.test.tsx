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
      images[0].getAttribute("src")?.replace("-light.png", "-dark.png"),
    ).toBe(images[1].getAttribute("src"));
  });

  it("centers page loading states across the available viewport", () => {
    render(<LoadingState variant="page" />);

    expect(screen.getByRole("status")).toHaveClass(
      "min-h-[calc(100dvh-12rem)]",
      "items-center",
      "justify-center",
    );
  });

  it("keeps inline loading states compact and accessible", () => {
    render(<LoadingState label="Loading token" variant="inline" />);

    const status = screen.getByRole("status", { name: "Loading token" });
    expect(status).toHaveClass("inline-flex", "min-h-0");
    expect(screen.queryByText("Loading token")).toBeNull();
  });
});
