import { cn } from "@/lib/utils";

/**
 * The incognito-chat mark: a blinking pixel creature, in a dark-art variant
 * for light mode and a light-art variant for dark mode. The single source for
 * every incognito affordance (sidebar rows, composer toggle, search palette)
 * so the visual stays consistent.
 *
 * Plain <img>, not next/image: the asset is a tiny looping GIF served from
 * /public and optimization would strip the animation.
 */
export function IncognitoIcon({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block shrink-0", className)}>
      <img
        src="/incognito/openappa-blink.gif"
        alt="Incognito chat"
        className="block size-full dark:hidden"
      />
      <img
        src="/incognito/openappa-blink-dark.gif"
        alt=""
        aria-hidden
        className="hidden size-full dark:block"
      />
    </span>
  );
}
