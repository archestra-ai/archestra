import type { ComponentProps } from "react";
import { cn } from "@/lib/utils/tailwind";

/**
 * The code/terminal surface shared by the connection wizard, the plugin
 * install dialog and the proxy pages. The `--terminal-*` tokens are derived
 * from the active theme (globals.css), so a block follows whichever theme and
 * mode is selected. Terminal-colored text must always sit on `bg-terminal`;
 * `TerminalCard` keeps the two together.
 */
export function TerminalCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-terminal-edge bg-terminal shadow-lg",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The raised fill shared by actions and the selected tab on a terminal
 * surface: white with a soft edge and shadow in light mode, the surface's
 * lighter elevated fill in dark mode.
 */
export const terminalRaisedClass =
  "border-border bg-background text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground dark:border-terminal-edge dark:bg-terminal-selected dark:text-terminal-foreground dark:hover:bg-terminal-selected dark:hover:text-terminal-emphasis";

/**
 * Icon-sized control on a terminal surface: copy, reveal, token switcher.
 * Every action on a code surface uses this one look; a toggle such as reveal
 * shows its state through its icon and `aria-pressed`, never a different fill.
 */
export const terminalActionClass =
  // Light: a raised white key on the tinted surface. Dark: a fill lighter
  // than the dark surface. Selected tabs on the surface share the same look.
  "flex items-center justify-center rounded border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg:not([class*='size-'])]:size-3.5 " +
  terminalRaisedClass;

/** The code itself — command lines, endpoints, header values. */
export const terminalCodeClass =
  "font-mono text-[13px] leading-[1.65] text-terminal-foreground";

/** Small uppercase field label above a value inside a terminal card. */
export const terminalLabelClass =
  "font-mono text-[11px] font-medium uppercase tracking-wider text-terminal-muted";
