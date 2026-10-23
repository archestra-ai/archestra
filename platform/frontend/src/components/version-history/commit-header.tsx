"use client";

import type { Permissions } from "@archestra/shared";
import { format } from "date-fns";
import { Check, Copy, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { copyToClipboard } from "@/lib/clipboard";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { HeadRef, SHORT_HASH_LENGTH, ShortHash } from "./refs";
import { ADDED_TEXT } from "./tones";

/**
 * The selected version read like `git show`: its number, whether it is HEAD,
 * and a commit / parent / date block, with the version's action on the right.
 *
 * Versions are contiguous, so the parent is always the number before — which
 * retention may have pruned; its hash is shown only once it has been read.
 */
export function CommitHeader({
  version,
  isHead,
  hash,
  parentHash,
  onSelectParent,
  createdAt,
  extraRows,
  action,
}: {
  version: number;
  isHead: boolean;
  /** Null for histories that do not hash their versions (apps). */
  hash: string | null;
  parentHash: string | null;
  onSelectParent: (version: number) => void;
  createdAt: string;
  /** More `<dt>`/`<dd>` pairs for the block, such as a skill's Git source. */
  extraRows?: ReactNode;
  action: ReactNode;
}) {
  const parent = version > 1 ? version - 1 : null;
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b px-6 pt-5 pb-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <h3 className="text-2xl leading-none font-semibold tracking-tight">
            Version {version}
          </h3>
          {isHead ? <HeadRef size="md" /> : null}
        </div>
        <dl className="mt-3.5 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-1 font-mono text-xs">
          {hash ? (
            <>
              <dt className="leading-5 text-muted-foreground">commit</dt>
              <dd className="flex min-w-0 items-center">
                <HashChip hash={hash} />
              </dd>
            </>
          ) : null}
          <dt className="leading-5 text-muted-foreground">parent</dt>
          <dd className="flex min-w-0 items-center leading-5">
            {parent === null ? (
              <span className="text-muted-foreground">none (root version)</span>
            ) : (
              <UnstyledButton
                aria-label={`Go to the parent version, version ${parent}`}
                onClick={() => onSelectParent(parent)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="font-semibold text-foreground">v{parent}</span>
                {parentHash ? <ShortHash hash={parentHash} /> : null}
              </UnstyledButton>
            )}
          </dd>
          <dt className="leading-5 text-muted-foreground">date</dt>
          <dd className="min-w-0 truncate leading-5 tabular-nums">
            <span>
              {format(new Date(createdAt), "EEE MMM d yyyy HH:mm:ss")}
            </span>
            <span className="text-muted-foreground">
              {` (${formatRelativeTimeFromNow(createdAt)})`}
            </span>
          </dd>
          {extraRows}
        </dl>
      </div>
      {action}
    </header>
  );
}

/**
 * The header for a version whose snapshot is not in hand — pruned, or a read
 * that failed. Its number and the action stay, so the action can say why it
 * is refused.
 */
export function UnreadVersionHeader({
  version,
  action,
}: {
  version: number;
  action: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b px-6 pt-5 pb-4">
      <h3 className="text-2xl leading-none font-semibold tracking-tight">
        Version {version}
      </h3>
      {action}
    </header>
  );
}

/**
 * Restore for the selected version, with its `r` shortcut on the keycap. A
 * refused restore stays focusable with its reason, which is what the shared
 * permission button does with a `tooltip` on a disabled control.
 */
export function RestoreButton({
  version,
  permissions,
  permissionScope,
  canRestore,
  tooltip,
  isPending = false,
  onClick,
}: {
  version: number;
  permissions: Permissions;
  permissionScope: string | undefined;
  canRestore: boolean;
  /** Why restore is refused, or what it does when it is not. */
  tooltip: string | undefined;
  isPending?: boolean;
  onClick: () => void;
}) {
  return (
    <PermissionButton
      permissions={permissions}
      permissionScope={permissionScope}
      disabled={!canRestore || isPending}
      tooltip={tooltip}
      size="sm"
      variant={canRestore ? "default" : "outline"}
      onClick={onClick}
    >
      <RotateCcw />
      <span>{isPending ? "Restoring..." : `Restore v${version}`}</span>
      <Kbd
        aria-hidden
        className={cn(
          "ml-0.5 font-mono",
          canRestore &&
            "border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground",
        )}
      >
        r
      </Kbd>
    </PermissionButton>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/** The full hash, shortened on screen and copied whole on click. */
function HashChip({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label="Copy content hash"
          className="group/hash inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] border bg-background px-1.5 leading-5 transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => {
            copyToClipboard(hash).then(
              () => setCopied(true),
              () => {},
            );
          }}
        >
          <ShortHash hash={hash} />
          <span className="hidden text-muted-foreground/60 sm:inline">
            {hash.slice(SHORT_HASH_LENGTH, 19)}
          </span>
          {copied ? (
            <Check className={cn("size-3", ADDED_TEXT)} />
          ) : (
            <Copy className="size-3 text-muted-foreground opacity-60 group-hover/hash:opacity-100" />
          )}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]">
        {copied ? "Copied" : hash}
      </TooltipContent>
    </Tooltip>
  );
}
