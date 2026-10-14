"use client";

import type { GitProvider } from "@archestra/shared";
import { Check, ChevronRight } from "lucide-react";
import type * as React from "react";
import { AgentIcon } from "@/components/agent-icon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { radioCardClass } from "@/components/ui/radio-group";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * The shared look of every Git setup dialog (skills, plugins, OpenAPPA): a
 * thin stepper, choice tiles, and a closed-by-default "Advanced" fold.
 */

/** A big clickable choice. Clicking it moves the setup on. */
export function ChoiceTile({
  onClick,
  disabled = false,
  visual,
  title,
  body,
}: {
  onClick: () => void;
  disabled?: boolean;
  visual: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      disabled={disabled}
      className={cn(
        radioCardClass(),
        "group flex flex-col items-start gap-6 rounded-lg p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {visual}
      <span className="space-y-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </UnstyledButton>
  );
}

/** A square holder for a tile's icon. */
export function TileIcon({
  children,
  dashed = false,
}: {
  children: React.ReactNode;
  dashed?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-lg border",
        dashed ? "border-dashed" : "bg-muted/40",
      )}
    >
      {children}
    </span>
  );
}

export function GitProviderLogo({
  provider,
  className,
  size = 16,
}: {
  provider: GitProvider;
  className?: string;
  size?: number;
}) {
  return (
    <AgentIcon
      icon={provider === "gitlab" ? "logo:gitlab" : "logo:github"}
      className={className}
      size={size}
    />
  );
}

/** Progress through the setup, one bar per step. */
export function SetupStepper({
  steps,
  current,
}: {
  steps: string[];
  /** Index of the active step; `steps.length` once all are done. */
  current: number;
}) {
  return (
    <ol
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label="Setup progress"
    >
      {steps.map((label, index) => {
        const complete = index < current;
        const active = index === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="min-w-0 space-y-1.5"
          >
            <span
              className={cn(
                "block h-0.5 rounded-full transition-colors duration-300",
                complete || active ? "bg-primary" : "bg-border",
              )}
            />
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {complete ? (
                <Check className="size-3 shrink-0 text-primary" />
              ) : (
                <span className="tabular-nums">{index + 1}</span>
              )}
              <span className="truncate">{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Optional settings, folded away until asked for. */
export function AdvancedFold({
  open,
  onOpenChange,
  hint,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is inside, e.g. "(branch, folder)". */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        <span>Advanced</span>
        {hint ? (
          <span className="font-normal text-muted-foreground/70">{hint}</span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** The repository a list was read from, with a way back to change it. */
export function RepositoryBar({
  provider,
  label,
  avatarUrl,
  onChange,
}: {
  provider: GitProvider;
  label: string;
  /** Only on github.com, where owner avatars are public. */
  avatarUrl: string | null;
  /** Omitted when there is nothing to go back to. */
  onChange?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2.5">
      <Avatar className="size-7 shrink-0">
        {avatarUrl ? <AvatarImage src={`${avatarUrl}?size=64`} alt="" /> : null}
        <AvatarFallback className="bg-background">
          <GitProviderLogo provider={provider} size={14} />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 truncate font-mono text-sm font-medium">
        {label}
      </div>
      {onChange ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onChange}
          className="shrink-0"
        >
          <span>Change</span>
        </Button>
      ) : null}
    </div>
  );
}
