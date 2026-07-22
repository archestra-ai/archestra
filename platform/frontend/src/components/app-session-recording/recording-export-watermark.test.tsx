import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecordingExportWatermark } from "./app-session-player";

describe("RecordingExportWatermark", () => {
  it("carries the Powered by Archestra.AI wordmark on the exported video", () => {
    render(<RecordingExportWatermark />);

    // "Powered by" reuses the wordmark's exact type, so both lines sit in one
    // styled block and share a left edge.
    const powered = screen.getByText("Powered by");
    const wordmark = screen.getByText("Archestra.AI");
    expect(powered).toBeInTheDocument();
    expect(wordmark).toBeInTheDocument();
    expect(powered.parentElement).toBe(wordmark.parentElement);
  });

  it("shows the official Archestra logo, decorative beside the visible name", () => {
    const { container } = render(<RecordingExportWatermark />);

    const logo = container.querySelector("img");
    // Decorative (alt="") — "Archestra.AI" is the visible label beside it.
    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("src", "/logo-icon.svg");
  });

  it("is a decorative lockup hidden from assistive tech", () => {
    const { container } = render(<RecordingExportWatermark />);

    const mark = container.firstElementChild;
    expect(mark).toHaveClass("items-center");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });
});
