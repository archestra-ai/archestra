import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecordingExportWatermark } from "./app-session-player";

describe("RecordingExportWatermark", () => {
  it("carries the Powered by Archestra.AI wordmark on the exported video", () => {
    render(<RecordingExportWatermark />);

    expect(screen.getByText("Powered by")).toBeInTheDocument();
    // The lockup reads "Archestra.AI" with ".AI" set apart in a muted grey.
    expect(screen.getByText(/Archestra/)).toHaveTextContent("Archestra.AI");
    expect(screen.getByText(".AI")).toBeInTheDocument();
  });

  it("shows the official Archestra logo, decorative beside the visible name", () => {
    const { container } = render(<RecordingExportWatermark />);

    const logo = container.querySelector("img");
    // Decorative (alt="") — "Archestra.AI" is the visible label beside it.
    expect(logo).toHaveAttribute("alt", "");
    expect(logo).toHaveAttribute("src", "/logo-icon.svg");
  });

  it("is centered and hidden from assistive tech — it rests in the composer box", () => {
    const { container } = render(<RecordingExportWatermark />);

    const mark = container.firstElementChild;
    expect(mark).toHaveClass("items-center", "justify-center");
    expect(mark).toHaveAttribute("aria-hidden", "true");
  });
});
