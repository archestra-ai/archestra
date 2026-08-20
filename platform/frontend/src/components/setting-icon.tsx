import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * How much a setting currently does. These are configuration intensities,
 * not health states — the strictest choice is a deliberate setting, so the
 * scale runs muted → informational blue → the theme's accent, never the
 * error palette.
 */
export type SettingTone = "on" | "info" | "off";

/** The dot inside a setting's state badge, per tone. */
export const SETTING_TONE_DOT: Record<SettingTone, string> = {
  on: "bg-green-500",
  info: "bg-blue-500",
  off: "bg-muted-foreground",
};

/**
 * A setting's icon in a box tinted by its tone. The wizard's rows and the
 * detail pages' read-only rows share it, so a setting looks the same where
 * it is changed and where it is read.
 */
export function SettingIcon({
  tone,
  children,
}: {
  tone: SettingTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md",
        SETTING_TONE_ICON[tone],
      )}
    >
      {children}
    </span>
  );
}

const SETTING_TONE_ICON: Record<SettingTone, string> = {
  on: "bg-primary/10 text-primary",
  info: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  off: "bg-muted text-muted-foreground",
};
