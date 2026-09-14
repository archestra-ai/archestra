import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { expect, test } from "./fixtures";

test("streamed words release finished animations without losing their fade or text", async ({
  page,
}) => {
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

  const text = "A synthetic streaming response. ".repeat(100);
  const markup = renderToStaticMarkup(
    createElement(
      Streamdown,
      {
        mode: "streaming",
        isAnimating: true,
        animated: { animation: "fadeIn", sep: "word" },
      },
      text,
    ),
  );
  const result = await page.evaluate((html) => {
    document.body.innerHTML = html;
    const words = [
      ...document.querySelectorAll<HTMLElement>("[data-sd-animate]"),
    ];
    const animations = words.flatMap((word) => word.getAnimations());

    // Seek the actual CSS animations instead of racing their short duration.
    for (const animation of animations) {
      animation.pause();
      animation.currentTime =
        Number(animation.effect?.getTiming().duration) / 2;
    }
    const fading = words.every((word) => {
      const opacity = Number(getComputedStyle(word).opacity);
      return opacity > 0 && opacity < 1;
    });

    for (const animation of animations) animation.finish();

    return {
      wordCount: words.length,
      animationCount: animations.length,
      fading,
      visible: words.every((word) => getComputedStyle(word).opacity === "1"),
      // A forwards-filled opacity animation keeps its compositing effect
      // after finishing. Thousands of these made Layerize block chat typing.
      retainedAnimations: words.flatMap((word) => word.getAnimations()).length,
      text: document.body.textContent,
    };
  }, markup);

  expect(result.wordCount).toBeGreaterThan(100);
  expect(result.animationCount).toBe(result.wordCount);
  expect(result.fading).toBe(true);
  expect(result.visible).toBe(true);
  expect(result.text?.trim()).toBe(text.trim());
  expect(result.retainedAnimations).toBe(0);
});
