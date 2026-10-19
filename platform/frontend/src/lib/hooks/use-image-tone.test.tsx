import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImageTone } from "./use-image-tone";

const SAMPLE_SIZE = 32;

/** Pixel data: the left half transparent, the right half black. */
function darkTransparentPixels(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SAMPLE_SIZE * SAMPLE_SIZE * 4);
  for (let y = 0; y < SAMPLE_SIZE; y++) {
    for (let x = SAMPLE_SIZE / 2; x < SAMPLE_SIZE; x++) {
      data[(y * SAMPLE_SIZE + x) * 4 + 3] = 255;
    }
  }
  return data;
}

function Probe({ src }: { src: string }) {
  const { tone, ref, onLoad } = useImageTone(src);
  return (
    <img ref={ref} onLoad={onLoad} src={src} alt="" data-tone={tone ?? ""} />
  );
}

describe("useImageTone", () => {
  const drawImage = vi.fn();
  const getImageData = vi.fn(() => ({ data: darkTransparentPixels() }));
  const imageConstructor = vi.fn();

  beforeEach(() => {
    drawImage.mockClear();
    getImageData.mockClear();
    imageConstructor.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      getImageData,
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("Image", imageConstructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("samples the rendered image once it loads, without loading it again", () => {
    render(<Probe src="/api/internal_mcp_catalog/a/icon?v=1" />);
    const image = screen.getByRole("presentation");

    expect(image).toHaveAttribute("data-tone", "");
    fireEvent.load(image);

    expect(image).toHaveAttribute("data-tone", "dark");
    expect(drawImage).toHaveBeenCalledWith(
      image,
      0,
      0,
      SAMPLE_SIZE,
      SAMPLE_SIZE,
    );
    expect(imageConstructor).not.toHaveBeenCalled();
  });

  it("samples an image that finished loading before the handler attached", () => {
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    const naturalWidth = vi
      .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
      .mockReturnValue(SAMPLE_SIZE);
    try {
      render(<Probe src="/api/internal_mcp_catalog/b/icon?v=1" />);
      const image = screen.getByRole("presentation");

      expect(image).toHaveAttribute("data-tone", "dark");
      expect(drawImage).toHaveBeenCalledWith(
        image,
        0,
        0,
        SAMPLE_SIZE,
        SAMPLE_SIZE,
      );
      expect(imageConstructor).not.toHaveBeenCalled();
    } finally {
      complete.mockRestore();
      naturalWidth.mockRestore();
    }
  });

  it("reuses a sampled tone for another image with the same source", () => {
    render(
      <>
        <Probe src="/api/internal_mcp_catalog/c/icon?v=1" />
        <Probe src="/api/internal_mcp_catalog/c/icon?v=1" />
      </>,
    );
    const [first, second] = screen.getAllByRole("presentation");

    fireEvent.load(first);
    fireEvent.load(second);

    expect(first).toHaveAttribute("data-tone", "dark");
    expect(second).toHaveAttribute("data-tone", "dark");
    expect(getImageData).toHaveBeenCalledTimes(1);
  });
});
