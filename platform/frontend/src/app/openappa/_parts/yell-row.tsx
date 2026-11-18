"use client";

import {
  Activity,
  AppWindow,
  Bot,
  Check,
  FileArchive,
  KeyRound,
  Link2,
  MessageCircle,
  MessagesSquare,
  RotateCcw,
  ShieldAlert,
  ShieldOff,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { CreatedByCell } from "@/components/created-by-cell";
import { TableRowActions } from "@/components/table-row-actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import {
  type OpenAppaYell,
  useOpenAppaYellArchive,
} from "@/lib/openappa-yells.query";
import { cn } from "@/lib/utils/tailwind";
import { useYellInvestigation } from "./use-yell-investigation";

export function YellRowActions({
  yell,
  canResolve,
  pending,
  onResolve,
  compact = false,
}: {
  yell: OpenAppaYell;
  canResolve: boolean;
  pending: boolean;
  onResolve: () => void;
  /**
   * For a table row: Copy link and what the yell left behind (its report,
   * its investigation chat, its place in the session trace) fold into a
   * More menu, so the row keeps two buttons and the menu.
   */
  compact?: boolean;
}) {
  const signals = useYellSignals(yell);
  const copyLink = {
    icon: <Link2 className="size-4" />,
    label: "Copy link",
    onClick: () => copyYellLink(yell.id),
  };
  const investigation = useYellInvestigation({
    id: yell.id,
    hasArchive: yell.hasArchive,
    conversationId: yell.conversation?.id ?? null,
  });
  return (
    <TableRowActions
      actions={[
        {
          icon: <MessageCircle className="size-4" />,
          label: investigation.label,
          permissions: investigation.permissions,
          disabled: investigation.disabled,
          onClick: investigation.launch,
        },
        ...(canResolve
          ? [
              {
                icon: yell.resolvedAt ? (
                  <RotateCcw className="size-4" />
                ) : (
                  <Check className="size-4" />
                ),
                label: yell.resolvedAt ? "Reopen" : "Mark resolved",
                disabled: pending,
                onClick: onResolve,
              },
            ]
          : []),
        ...(compact ? [] : [copyLink]),
      ]}
      dropdownActions={
        compact
          ? [
              ...signals.map((signal) => ({
                icon: signal.icon,
                label: signal.label,
                href: signal.href,
                onClick: signal.onClick,
                disabled: signal.disabled,
              })),
              copyLink,
            ]
          : undefined
      }
    />
  );
}

/** The yell's detail page. */
export function yellHref(id: string) {
  return `/consults/logs/yells/${id}`;
}

async function copyYellLink(id: string) {
  try {
    await copyToClipboard(new URL(yellHref(id), window.location.origin).href);
    toast.success("Link copied");
  } catch {
    toast.error("Could not copy the link");
  }
}

/**
 * What the yell left behind, each one a shortcut: its report to download,
 * its investigation chat, its place in the session trace. Only the ones it
 * has, packed together.
 */
export function YellSignals({
  yell,
  empty = null,
}: {
  yell: OpenAppaYell;
  /** Shown when the yell left nothing behind. */
  empty?: ReactNode;
}) {
  const signals = useYellSignals(yell);
  if (signals.length === 0) return empty;
  const className =
    "inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5";
  return (
    <div className="-ml-1 flex shrink-0 items-center">
      {signals.map((signal) => (
        <Tooltip key={signal.key}>
          <TooltipTrigger asChild>
            {signal.href ? (
              <Link
                href={signal.href}
                aria-label={signal.label}
                className={className}
              >
                {signal.icon}
              </Link>
            ) : (
              <UnstyledButton
                aria-label={signal.label}
                onClick={signal.onClick}
                disabled={signal.disabled}
                className={className}
              >
                {signal.icon}
              </UnstyledButton>
            )}
          </TooltipTrigger>
          <TooltipContent>{signal.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** What the yell left behind, each one a shortcut; only the ones it has. */
function useYellSignals(yell: OpenAppaYell) {
  const archive = useOpenAppaYellArchive();
  const traceHref = useYellTraceHref(yell);
  const signals: {
    key: string;
    label: string;
    icon: ReactNode;
    href?: string;
    onClick?: () => void;
    disabled?: boolean;
  }[] = [];
  if (yell.hasArchive)
    signals.push({
      key: "report",
      label: "Download report",
      icon: <FileArchive />,
      onClick: () => archive.mutate({ id: yell.id, download: true }),
      disabled: archive.isPending,
    });
  if (yell.conversation)
    signals.push({
      key: "chat",
      label: "Open the investigation chat",
      icon: <MessagesSquare />,
      href: `/chat/${yell.conversation.id}`,
    });
  if (traceHref)
    signals.push({
      key: "trace",
      label: "View in the session trace",
      icon: <Activity />,
      href: traceHref,
    });
  return signals;
}

/**
 * The yell's session trace, opened on its `yell` call. Only for a session
 * whose requests were logged, and that the viewer may read: their own, or
 * anyone's with `log:admin`.
 */
function useYellTraceHref(yell: OpenAppaYell): string | null {
  const { data: session } = useSession();
  const { data: canReadAllLogs } = useHasPermissions({ log: ["admin"] });
  const { trace } = yell;
  if (!trace) return null;
  const own = session?.user.id && yell.callerId === `user:${session.user.id}`;
  if (!own && !canReadAllLogs) return null;
  return llmSessionHref(
    trace.llmSessionId,
    trace.mcpToolCallId ? { toolCall: trace.mcpToolCallId } : undefined,
  );
}

export function YellCaller({ yell }: { yell: OpenAppaYell }) {
  if (yell.caller)
    return (
      <CreatedByCell createdBy={yell.caller} showServiceAccountBadge={false} />
    );
  const { callerId, callerApp } = yell;
  const shape = callerApp
    ? ([AppWindow, callerApp.name, true] as const)
    : callerId.startsWith("app:")
      ? ([AppWindow, "Deleted app", false] as const)
      : callerId.startsWith("virtual-key:")
        ? ([KeyRound, "Virtual key", false] as const)
        : callerId.startsWith("user:service-account:")
          ? ([Bot, "Unknown service account", false] as const)
          : callerId.startsWith("user:")
            ? ([UserRound, "Unknown user", false] as const)
            : null;
  // No one to name: the same dash as an empty Signals cell.
  if (!shape)
    return (
      <span className="text-muted-foreground" title="Unattributed caller">
        —
      </span>
    );
  const [Icon, label, known] = shape;
  // The same avatar-and-name shape as a person's cell, so the column reads as
  // one list whatever kind of caller sent the yell.
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar className="h-5 w-5 shrink-0" aria-hidden="true">
        <AvatarFallback>
          <Icon className="size-3" aria-hidden="true" />
        </AvatarFallback>
      </Avatar>
      <span
        className={cn("min-w-0 truncate", !known && "text-muted-foreground")}
      >
        {label}
        {callerApp ? <span className="sr-only"> (app)</span> : null}
      </span>
    </span>
  );
}

export const BROKE_THE_GLASS_HINT =
  "Broke the glass: guardrails turned off for this session";

/** The same guardrails marker on desktop/mobile rows and the detail page. */
export function YellGuardrailsMark({ yell }: { yell: OpenAppaYell }) {
  return yell.kind === "agent" ? (
    <BrokeTheGlassMark yell={yell} />
  ) : (
    <WaivedCallMark yell={yell} />
  );
}

/**
 * For a yell the platform raised under the Break the glass settings: which
 * kind of blocked call it let through, and how many times.
 */
function WaivedCallMark({ yell }: { yell: OpenAppaYell }) {
  if (yell.kind === "agent") return null;
  const hint = `${WAIVED_CALL_HINT[yell.kind]}${yell.count > 1 ? ` (${yell.count} calls)` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 cursor-default items-center gap-0.5 text-xs text-muted-foreground">
          <ShieldAlert className="size-3.5" aria-label={hint} />
          {yell.count > 1 && (
            <span className="tabular-nums">×{yell.count}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

const WAIVED_CALL_HINT = {
  approval_waived: "Break the glass waived human approval",
  block_waived: "Other blocked calls: a blocked call was let through",
} as const;

/** A shield-off icon with its explanation on hover; nothing for a plain yell. */
function BrokeTheGlassMark({ yell }: { yell: OpenAppaYell }) {
  if (!yell.superyell) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 cursor-default text-muted-foreground">
          <ShieldOff className="size-3.5" aria-label={BROKE_THE_GLASS_HINT} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{BROKE_THE_GLASS_HINT}</TooltipContent>
    </Tooltip>
  );
}

/** A resolved yell reads as done: all but its shortcuts recede. */
export function YellFaded({
  yell,
  className,
  children,
}: {
  yell: OpenAppaYell;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", yell.resolvedAt && "opacity-60", className)}>
      {children}
    </div>
  );
}
