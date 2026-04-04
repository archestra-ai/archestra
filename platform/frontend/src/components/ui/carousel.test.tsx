import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from "./carousel";

// embla-carousel needs matchMedia, ResizeObserver, IntersectionObserver as constructors
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

describe("Carousel keyboard navigation", () => {
  function renderCarousel() {
    let api: CarouselApi;
    const result = render(
      <Carousel
        setApi={(a) => {
          api = a;
        }}
      >
        <CarouselContent>
          <CarouselItem>
            <p>Slide 1</p>
            <input data-testid="slide-input" type="text" />
          </CarouselItem>
          <CarouselItem>
            <p>Slide 2</p>
            <textarea data-testid="slide-textarea" />
          </CarouselItem>
          <CarouselItem>
            <p>Slide 3</p>
            <select data-testid="slide-select">
              <option>A</option>
              <option>B</option>
            </select>
          </CarouselItem>
        </CarouselContent>
      </Carousel>,
    );
    // biome-ignore lint/style/noNonNullAssertion: api is set synchronously by embla
    const scrollNextSpy = vi.spyOn(api!, "scrollNext");
    // biome-ignore lint/style/noNonNullAssertion: api is set synchronously by embla
    const scrollPrevSpy = vi.spyOn(api!, "scrollPrev");
    return { ...result, scrollNextSpy, scrollPrevSpy };
  }

  it("does not scroll when ArrowRight is pressed while an input is focused", async () => {
    const user = userEvent.setup();
    const { scrollNextSpy } = renderCarousel();

    const input = screen.getByTestId("slide-input");
    await user.click(input);
    await user.keyboard("{ArrowRight}");

    expect(scrollNextSpy).not.toHaveBeenCalled();
  });

  it("does not scroll when ArrowLeft is pressed while a textarea is focused", async () => {
    const user = userEvent.setup();
    const { scrollPrevSpy } = renderCarousel();

    const textarea = screen.getByTestId("slide-textarea");
    await user.click(textarea);
    await user.keyboard("{ArrowLeft}");

    expect(scrollPrevSpy).not.toHaveBeenCalled();
  });

  it("does not scroll when arrow keys are pressed while a select is focused", async () => {
    const user = userEvent.setup();
    const { scrollNextSpy, scrollPrevSpy } = renderCarousel();

    const select = screen.getByTestId("slide-select");
    await user.click(select);
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");

    expect(scrollNextSpy).not.toHaveBeenCalled();
    expect(scrollPrevSpy).not.toHaveBeenCalled();
  });

  it("scrolls when arrow keys are pressed on the carousel region itself", () => {
    const { scrollNextSpy, scrollPrevSpy } = renderCarousel();

    const carousel = screen.getByRole("region");
    fireEvent.keyDown(carousel, { key: "ArrowRight" });
    expect(scrollNextSpy).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(carousel, { key: "ArrowLeft" });
    expect(scrollPrevSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls after clicking on non-interactive area (focus moves to carousel)", async () => {
    const user = userEvent.setup();
    const { scrollNextSpy } = renderCarousel();

    // First focus on an input
    const input = screen.getByTestId("slide-input");
    await user.click(input);
    expect(document.activeElement).toBe(input);

    // Click on a non-interactive element (paragraph) inside the carousel
    const paragraph = screen.getByText("Slide 1");
    await user.click(paragraph);

    // Carousel should now have focus
    const carousel = screen.getByRole("region");
    expect(document.activeElement).toBe(carousel);

    // Arrow keys should now navigate the carousel
    await user.keyboard("{ArrowRight}");
    expect(scrollNextSpy).toHaveBeenCalledTimes(1);
  });

  // Note: contentEditable is also handled by the production code (via isContentEditable check)
  // but jsdom doesn't properly implement isContentEditable, so we can't test it here.
});
