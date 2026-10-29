"use client";

// Building blocks shared by the MCP server console's top bar, status bar and
// per-tab bodies (logs, inspector, shell).

import type { McpDeploymentStatusEntry } from "@archestra/shared";
import { Check, CircleAlert, Copy, Info, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils/tailwind";
import {
  type DeploymentState,
  DeploymentStatusDot,
  getDeploymentLabel,
} from "./deployment-status";

export type ConnState =
  | McpDeploymentStatusEntry["state"]
  | "degraded"
  | "unknown";

export function connState(s: McpDeploymentStatusEntry | undefined): ConnState {
  if (!s) return "unknown";
  return s.state === "succeeded" ? "running" : s.state;
}

export function connStateLabel(state: ConnState) {
  if (state === "not_created") return "Not deployed";
  if (state === "unknown") return "Starting";
  return getDeploymentLabel(state as DeploymentState);
}

export async function copyText(text: string, success: string) {
  if (!text) return;
  try {
    await copyToClipboard(text);
    toast.success(success);
  } catch {
    toast.error("Failed to copy");
  }
}

/** Status dot that also has a look for "never deployed" (hollow). */
export function ConnDot({ state }: { state: ConnState }) {
  if (state === "not_created") {
    return (
      <span className="size-2 shrink-0 rounded-full border border-slate-500" />
    );
  }
  return (
    <DeploymentStatusDot
      state={(state === "unknown" ? "pending" : state) as DeploymentState}
    />
  );
}

export function BarButton({
  icon,
  label,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      className="text-slate-400 hover:bg-slate-800 hover:text-slate-100 dark:hover:bg-slate-800 [&_svg]:size-3.5"
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export function BarToggle({
  pressed,
  onClick,
  icon,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "hover:bg-slate-800 hover:text-slate-100 dark:hover:bg-slate-800 [&_svg]:size-3.5",
        pressed ? "bg-slate-800/80 text-slate-100" : "text-slate-400",
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export function SegButton({
  active,
  onClick,
  icon,
  label,
  tip,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  tip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={active}
          aria-label={label}
          onClick={onClick}
          className={cn(
            "h-6 rounded-[5px] [&_svg]:size-3.5",
            active
              ? "bg-slate-700/70 text-slate-50 hover:bg-slate-700/70 hover:text-slate-50 dark:hover:bg-slate-700/70"
              : "text-slate-400 hover:bg-transparent hover:text-slate-200 dark:hover:bg-transparent",
          )}
        >
          {icon}
          <span className="hidden sm:inline">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

export function Pulse({
  tone,
}: {
  tone: "live" | "rec" | "ok" | "warn" | "off" | "err";
}) {
  const color = {
    live: "bg-emerald-400",
    ok: "bg-emerald-400",
    rec: "bg-emerald-400",
    warn: "bg-amber-400",
    off: "bg-slate-600",
    err: "bg-red-400",
  }[tone];
  return (
    <span className="relative flex size-1.5 shrink-0">
      {(tone === "live" || tone === "rec") && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            color,
          )}
        />
      )}
      <span
        className={cn("relative inline-flex size-1.5 rounded-full", color)}
      />
    </span>
  );
}

/**
 * One status-bar cell. `hideBelow` drops low-priority cells on narrow
 * frames instead of letting them collide with the command chip.
 */
export function StatusItem({
  children,
  hideBelow,
}: {
  children: ReactNode;
  hideBelow?: "sm" | "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "shrink-0 items-center gap-1.5",
        hideBelow ? HIDE_BELOW[hideBelow] : "flex",
      )}
    >
      {children}
    </span>
  );
}

export function CommandChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <span className="shrink-0 text-slate-600">$</span>
      <span className="min-w-0 truncate text-slate-400" title={command}>
        {command}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label="Copy command"
            onClick={async () => {
              await copyText(command, "Command copied to clipboard");
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          >
            {copied ? (
              <Check className="size-3 text-emerald-400" />
            ) : (
              <Copy className="size-3" />
            )}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent>Copy the equivalent kubectl command</TooltipContent>
      </Tooltip>
    </>
  );
}

export function ConsoleState({
  tone,
  title,
  detail,
  action,
  testId,
}: {
  tone: "info" | "loading" | "error" | "warning";
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  const Icon =
    tone === "loading" ? Loader2 : tone === "info" ? Info : CircleAlert;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
      className="flex min-h-0 flex-1 items-center justify-center p-6"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-md border bg-slate-900",
            tone === "error" && "border-red-400/20 text-red-400",
            tone === "warning" && "border-amber-400/20 text-amber-400",
            (tone === "info" || tone === "loading") &&
              "border-slate-800 text-slate-400",
          )}
        >
          <Icon
            className={cn(
              "size-4",
              tone === "loading" && "animate-spin motion-reduce:animate-none",
            )}
          />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-100">{title}</p>
          {detail ? (
            <p className="text-xs leading-relaxed text-slate-400">{detail}</p>
          ) : null}
        </div>
        {action}
      </div>
    </div>
  );
}

const HIDE_BELOW = {
  sm: "hidden sm:flex",
  md: "hidden md:flex",
  lg: "hidden lg:flex",
} as const;
