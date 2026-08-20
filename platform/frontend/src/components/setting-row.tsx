import type { ReactNode } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  SETTING_TONE_DOT,
  SettingIcon,
  type SettingTone,
} from "@/components/setting-icon";
import { cn } from "@/lib/utils";

/** A group of read-only setting rows, as one bordered list. */
export function SettingRows({ children }: { children: ReactNode }) {
  return <div className="divide-y rounded-md border">{children}</div>;
}

/**
 * One of the wizard's switch-and-select settings, read-only: the wizard's own
 * row — an icon, the setting's name and a line on what its current state
 * means — with the control replaced by the state, as one badge on the right.
 */
export function SettingRow({
  icon,
  title,
  badge,
  tone,
  state,
  learnMoreHref,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  /** Rendered after the name, before the state — e.g. a Beta pill. */
  badge?: ReactNode;
  tone: SettingTone;
  state: string;
  /** The public docs on this setting; hidden under white-labeling. */
  learnMoreHref?: string;
  /** Where the setting itself is configured, at the row's right edge. */
  action?: ReactNode;
  /** What the current state means, in one line. */
  children: ReactNode;
}) {
  return (
    // The icon centres on the two-line text block; the state sits right
    // after the setting's name, where the eye lands first. The icon's tint
    // follows the tone scale: accent while fully on, blue while
    // informational, muted otherwise.
    <div className="flex items-center gap-3 p-3">
      <SettingIcon tone={tone}>{icon}</SettingIcon>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium leading-5">{title}</span>
          {badge}
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
              tone === "off" && "text-muted-foreground",
            )}
          >
            <span
              className={cn("size-1.5 rounded-full", SETTING_TONE_DOT[tone])}
            />
            {state}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {children}
          {learnMoreHref && (
            <>
              {" "}
              <ExternalDocsLink
                href={learnMoreHref}
                className="underline"
                showIcon={false}
              >
                Learn more
              </ExternalDocsLink>
            </>
          )}
        </p>
      </div>
      {action}
    </div>
  );
}
