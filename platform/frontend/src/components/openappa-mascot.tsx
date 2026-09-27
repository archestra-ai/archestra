"use client";

import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { cn } from "@/lib/utils/tailwind";

/**
 * The OpenAPPA mascot, stepping in place.
 *
 * The artwork is drawn twice rather than tinted — a dark creature for a light
 * ground, a light one for a dark ground — so the file swaps with the theme.
 *
 * A reader who asked for less motion gets the still mark instead: CSS cannot
 * pause an animated GIF, so honouring the preference means rendering something
 * else. The mark is the same silhouette, so the page does not change shape.
 */
export function OpenAppaMascot({ className }: { className?: string }) {
  return (
    <span className={cn("block", className)}>
      <span className="block size-full motion-reduce:hidden">
        <img
          src="/loading/openappa-step-light.gif"
          alt=""
          aria-hidden
          className="size-full dark:hidden"
        />
        <img
          src="/loading/openappa-step-dark.gif"
          alt=""
          aria-hidden
          className="hidden size-full dark:block"
        />
      </span>
      <OpenAppaSolidIcon
        aria-hidden
        className="mx-auto hidden h-full w-auto motion-reduce:block"
      />
    </span>
  );
}
