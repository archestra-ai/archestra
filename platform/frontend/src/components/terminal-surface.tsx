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

/** Icon-sized control on a terminal surface: copy, reveal, token switcher. */
export const terminalActionClass =
  "flex items-center justify-center rounded border border-terminal-edge bg-terminal-elevated text-terminal-muted transition-colors hover:text-terminal-emphasis disabled:opacity-50";

/** The code itself — command lines, endpoints, header values. */
export const terminalCodeClass =
  "font-mono text-[13px] leading-[1.65] text-terminal-foreground";

/** Small uppercase field label above a value inside a terminal card. */
export const terminalLabelClass =
  "font-mono text-[11px] font-medium uppercase tracking-wider text-terminal-muted";
