"use client";

import {
  type ReactEventHandler,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * How a transparent logo reads against the page: `dark` marks (a black
 * Anthropic logo) vanish on the dark theme, `light` marks on the light theme.
 * Opaque images and colourful logos carry their own contrast and stay `null`.
 */
export type ImageTone = "dark" | "light" | null;

const SAMPLE_SIZE = 32;
const toneCache = new Map<string, ImageTone>();

export interface ImageToneHandle {
  tone: ImageTone;
  /** Attach to the rendered image so it can be sampled once it has loaded. */
  ref: RefObject<HTMLImageElement | null>;
  onLoad: ReactEventHandler<HTMLImageElement>;
}

/**
 * Samples the tone from the image the component renders. An earlier version
 * loaded the source a second time through `new Image()`, and because the
 * rendered element carries a different URL (next/image adds the deployment
 * id, or routes through the optimizer), every icon was fetched twice.
 *
 * `src` is the component's own key for the cache; the pixels come from the
 * rendered element, whatever URL it ended up loading.
 */
export function useImageTone(src: string | null | undefined): ImageToneHandle {
  const [tone, setTone] = useState<{ src: string; tone: ImageTone } | null>(
    null,
  );
  const ref = useRef<HTMLImageElement | null>(null);

  const sample = useCallback(
    (image: HTMLImageElement) => {
      if (!src) return;
      let detected = toneCache.get(src);
      if (detected === undefined) {
        detected = sampleTone(image);
        toneCache.set(src, detected);
      }
      setTone({ src, tone: detected });
    },
    [src],
  );

  useEffect(() => {
    if (!src) return;
    const cached = toneCache.get(src);
    if (cached !== undefined) {
      setTone({ src, tone: cached });
      return;
    }
    // A server-rendered image can finish loading before React attaches the
    // load handler; it then never fires, so sample a complete image here.
    const image = ref.current;
    if (image?.complete && image.naturalWidth > 0) {
      sample(image);
    }
  }, [src, sample]);

  const onLoad = useCallback<ReactEventHandler<HTMLImageElement>>(
    (event) => sample(event.currentTarget),
    [sample],
  );

  return { tone: tone && tone.src === src ? tone.tone : null, ref, onLoad };
}

/** Tile classes that give a low-contrast logo a backdrop in the theme it would vanish in. */
export function imageToneClassName(tone: ImageTone): string | undefined {
  switch (tone) {
    case "dark":
      return "dark:bg-zinc-100 dark:p-0.5";
    case "light":
      return "bg-zinc-800 p-0.5 dark:bg-transparent dark:p-0";
    default:
      return undefined;
  }
}

function sampleTone(image: HTMLImageElement): ImageTone {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    let weight = 0;
    let luminance = 0;
    let transparentPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3] / 255;
      if (alpha < 0.1) {
        transparentPixels++;
        continue;
      }
      const pixelLuminance =
        (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      luminance += pixelLuminance * alpha;
      weight += alpha;
    }

    // A logo that fills its own square already has a background.
    if (weight === 0 || transparentPixels < (SAMPLE_SIZE * SAMPLE_SIZE) / 10) {
      return null;
    }
    const average = luminance / weight;
    if (average < 0.3) return "dark";
    if (average > 0.85) return "light";
    return null;
  } catch {
    // Cross-origin images taint the canvas; leave them as they are.
    return null;
  }
}
