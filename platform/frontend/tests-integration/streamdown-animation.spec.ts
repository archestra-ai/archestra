import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  // Load the application's compiled CSS, then isolate Streamdown's real markup.
  // This regression lives in the browser's animation/compositing engine; jsdom
  // and timing assertions on a shared CI runner cannot establish the contract.
  await page.goto("/auth/sign-in");
  const styles = await page
    .locator('link[rel="stylesheet"], style')
    .evaluateAll((elements) =>
      elements.map((element) => element.outerHTML).join(""),
    );
  await page.setContent(`<html><head>${styles}</head><body></body></html>`);
});

for (const format of ["paragraph", "bullets", "numbers"] as const) {
  test(`streamed ${format} release finished animations without losing their fade or text`, async ({
    page,
  }) => {
    const line = "A synthetic streaming response.";
    const lines = Array.from({ length: 100 }, () => line);
    const text =
      format === "paragraph"
        ? lines.join(" ")
        : lines
            .map(
              (text, index) =>
                `${format === "bullets" ? "-" : `${index + 1}.`} ${text}`,
            )
            .join("\n");
    const markup = renderToStaticMarkup(
      createElement(
        Streamdown,
        {
          mode: "streaming",
          isAnimating: true,
          animated: { animation: "fadeIn", sep: "word", stagger: 0 },
        },
        text,
      ),
    );
    const result = await page.evaluate((html) => {
      document.body.innerHTML = html;
      const words = [
        ...document.querySelectorAll<HTMLElement>("[data-sd-animate]"),
      ];
      const markers = [
        ...document.querySelectorAll<HTMLElement>("[data-sd-animate-marker]"),
      ];
      const animations = document.getAnimations();

      // Seek the actual word and ::marker animations instead of racing them.
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 0;
      }
      const initialColors = markers.map(
        (marker) => getComputedStyle(marker, "::marker").color,
      );
      for (const animation of animations) {
        animation.currentTime =
          Number(animation.effect?.getTiming().duration) / 2;
      }
      const fading = words.every((word) => {
        const opacity = Number(getComputedStyle(word).opacity);
        return opacity > 0 && opacity < 1;
      });
      const markersFading = markers.every((marker, index) => {
        const color = getComputedStyle(marker, "::marker").color;
        return (
          color !== initialColors[index] &&
          color !== getComputedStyle(marker).color
        );
      });

      for (const animation of animations) animation.finish();

      return {
        wordCount: words.length,
        markerCount: markers.length,
        animationCount: animations.length,
        fading,
        markersFading,
        visible: words.every((word) => getComputedStyle(word).opacity === "1"),
        markersVisible: markers.every(
          (marker) =>
            getComputedStyle(marker, "::marker").color ===
            getComputedStyle(marker).color,
        ),
        // Finished animations must release their effects, including list markers.
        retainedAnimations: document.getAnimations().length,
        text: words.map((word) => word.textContent).join(" "),
      };
    }, markup);

    expect(result.wordCount).toBeGreaterThan(100);
    expect(result.markerCount).toBe(format === "paragraph" ? 0 : lines.length);
    expect(result.animationCount).toBe(result.wordCount + result.markerCount);
    expect(result.fading).toBe(true);
    expect(result.markersFading).toBe(true);
    expect(result.visible).toBe(true);
    expect(result.markersVisible).toBe(true);
    expect(result.text.replace(/\s+/g, " ").trim()).toBe(lines.join(" "));
    expect(result.retainedAnimations).toBe(0);
  });
}
