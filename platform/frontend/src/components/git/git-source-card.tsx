"use client";

import type { GitProvider } from "@archestra/shared";
import {
  AlertTriangle,
  ExternalLink,
  GitBranch,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import { PageHeaderBanner } from "@/components/page-header-banner";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { cn } from "@/lib/utils/tailwind";

/**
 * A synced Git source at a glance: where it lives, how it is kept up to date,
 * and the few actions on it. Settings are edited in a dialog the footer
 * actions open, never inline, so the card stays a summary.
 */
export function GitSourceCard({
  provider,
  repo,
  href,
  details,
  sync,
  footer,
  actions,
  sticky = false,
  children,
}: {
  provider: GitProvider;
  /** owner/repo, or group/project on GitLab. */
  repo: string;
  href?: string;
  /** Short facts under the repository: branch, schedule, last check. */
  details: ReactNode;
  sync?: {
    onClick: () => void;
    pending: boolean;
    label?: string;
    tooltip?: ReactNode;
  };
  footer?: ReactNode;
  actions?: ReactNode;
  /**
   * Stay at the top of the page while it scrolls: on a page whose content the
   * source locks, it keeps saying why.
   */
  sticky?: boolean;
  /** Notices between the summary and the footer. */
  children?: ReactNode;
}) {
  const syncButton = sync && (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={sync.pending}
      onClick={sync.onClick}
    >
      <RefreshCw className={cn("size-3.5", sync.pending && "animate-spin")} />
      <span>{sync.pending ? "Syncing…" : (sync.label ?? "Sync now")}</span>
    </Button>
  );
  const isMobile = useIsMobile();
  const card = (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card",
        // The ring of page background hides what scrolls underneath.
        sticky &&
          !isMobile &&
          "shadow-md shadow-background ring-12 ring-background",
      )}
    >
      <div className="flex flex-wrap items-center gap-4 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <div className="hidden size-10 shrink-0 items-center justify-center rounded-md bg-muted sm:flex">
            <GitProviderLogo
              provider={provider}
              size={20}
              className="text-muted-foreground"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            {href ? (
              <a
                className="inline-flex max-w-full items-center gap-2 text-sm leading-5 font-medium hover:underline underline-offset-4"
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                <span className="truncate">{repo}</span>
                <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <p className="truncate text-sm leading-5 font-medium">{repo}</p>
            )}
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {details}
            </div>
          </div>
        </div>
        {syncButton && (
          <div className="flex items-center gap-2 sm:ml-auto">
            {sync?.tooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>{syncButton}</TooltipTrigger>
                <TooltipContent>{sync.tooltip}</TooltipContent>
              </Tooltip>
            ) : (
              syncButton
            )}
          </div>
        )}
      </div>
      {children}
      {(footer || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/30 px-4 py-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {footer}
          </p>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
    </div>
  );
  // Sticky: in the page banner slot, just under the sticky page header. Not
  // on a phone, where a pinned card would take much of the screen.
  return sticky && !isMobile ? (
    <PageHeaderBanner>{card}</PageHeaderBanner>
  ) : (
    card
  );
}

/** The branch a source follows, or its default branch. */
export function GitSourceBranch({ branch }: { branch: string | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      <GitBranch className="size-3.5" />
      {branch || "Default branch"}
    </span>
  );
}

/** A notice inside the card, between the summary and the footer. */
export function GitSourceNotice({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-4">{children}</div>;
}

export function GitSourceError({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <GitSourceNotice>
      <InlineNotice variant="error">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="font-medium">{title}</span>
        <InlineNoticeText>{message}</InlineNoticeText>
      </InlineNotice>
    </GitSourceNotice>
  );
}

/**
 * Where a Git-sourced page's content comes from, on hover of its icon. Takes
 * the place of a badge beside the title: the icon already shows the host.
 */
export function GitSourceTooltip({
  label,
  detail,
  children,
}: {
  /** "Synced from GitLab", "Imported from GitHub". */
  label: string;
  /** The repository, shown under the label. */
  detail?: string | null;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A hover nicety on a decorative tile: the source card says the
            same in text, for everyone. */}
        <span className="flex items-center justify-center">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-80">
        <p className="font-medium">{label}</p>
        {detail && <p className="break-all opacity-80">{detail}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
