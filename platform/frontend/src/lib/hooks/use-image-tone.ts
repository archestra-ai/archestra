"use client";

import { useEffect, useState } from "react";

/**
 * How a transparent logo reads against the page: `dark` marks (a black
 * Anthropic logo) vanish on the dark theme, `light` marks on the light theme.
 * Opaque images and colourful logos carry their own contrast and stay `null`.
 */
export type ImageTone = "dark" | "light" | null;

const SAMPLE_SIZE = 32;
const toneCache = new Map<string, Promise<ImageTone>>();

export function useImageTone(src: string | null | undefined): ImageTone {
  const [tone, setTone] = useState<{ src: string; tone: ImageTone } | null>(
    null,
  );

  useEffect(() => {
    if (!src) return;
    let active = true;
    let pending = toneCache.get(src);
    if (!pending) {
      pending = detectImageTone(src);
      toneCache.set(src, pending);
    }
    pending.then((detected) => {
      if (active) setTone({ src, tone: detected });
    });
    return () => {
      active = false;
    };
  }, [src]);

  return tone && tone.src === src ? tone.tone : null;
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

function detectImageTone(src: string): Promise<ImageTone> {
  return new Promise((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve(sampleTone(image));
    image.onerror = () => resolve(null);
    image.src = src;
  });
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
