"use client";

import {
  Bot,
  Cpu,
  Fingerprint,
  KeyRound,
  type LucideIcon,
  User,
} from "lucide-react";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { AuditLog } from "@/lib/audit-log/audit-log.query";
import { cn } from "@/lib/utils/tailwind";
import { ACTOR_TYPE_LABEL } from "./audit-log-action-labels";

type AuditActorEvent = Pick<
  AuditLog,
  | "actorId"
  | "actorName"
  | "actorEmail"
  | "actorType"
  | "impersonatedBy"
  | "impersonatedByEmail"
>;

/**
 * Who acted: people round on their hue, machines (service accounts, API keys,
 * SSO) square, then their email or kind — or who was impersonating them.
 */
export function AuditActorCell({ event }: { event: AuditActorEvent }) {
  const actor = describeAuditActor(event);
  const Icon = actor.icon;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {actor.kind === "person" ? (
        <PersonAvatar name={actor.name} size={32} ring={false} />
      ) : actor.quiet ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
      ) : (
        <AgentIdenticon seed={actor.seed} name={actor.name} variant="agent" />
      )}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm leading-5 font-medium",
            actor.quiet && "font-normal text-muted-foreground",
          )}
          title={actor.name}
        >
          {actor.name}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
          {event.impersonatedBy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <UnstyledButton className="flex min-w-0 cursor-default items-center gap-1">
                  <span className="shrink-0 text-muted-foreground/70">via</span>
                  <span className="truncate text-foreground/80">
                    {event.impersonatedByEmail ?? "deleted user"}
                  </span>
                </UnstyledButton>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs px-2 py-1.5">
                {event.impersonatedByEmail ?? "A deleted user"} acted as{" "}
                {actor.name} through impersonation.
              </TooltipContent>
            </Tooltip>
          ) : (
            <>
              {actor.kind === "machine" && !actor.quiet ? (
                <Icon className="size-3 shrink-0" aria-hidden="true" />
              ) : null}
              <span className="truncate">{actor.secondary}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The actor as the audit trail names them, for the cell and the pinned badge. */
export function describeAuditActor(event: AuditActorEvent): AuditActor {
  const seed = event.actorId ?? event.actorName ?? event.actorType;
  switch (event.actorType) {
    case "user": {
      const name = event.actorName ?? event.actorEmail ?? "Deleted user";
      return {
        kind: "person",
        name,
        secondary:
          event.actorEmail && event.actorEmail !== name
            ? event.actorEmail
            : ACTOR_TYPE_LABEL.user,
        icon: User,
        seed,
        quiet: !event.actorName && !event.actorEmail,
      };
    }
    case "service_account":
      return {
        kind: "machine",
        name: event.actorName ?? "Deleted service account",
        secondary: ACTOR_TYPE_LABEL.service_account,
        icon: Bot,
        seed,
      };
    case "api_key":
      return {
        kind: "machine",
        name: event.actorName ?? "Deleted API key",
        secondary: ACTOR_TYPE_LABEL.api_key,
        icon: KeyRound,
        seed,
      };
    case "sso":
      return {
        kind: "machine",
        name: event.actorName ?? "Identity provider",
        secondary: ACTOR_TYPE_LABEL.sso,
        icon: Fingerprint,
        seed,
      };
    default:
      return {
        kind: "machine",
        name: "System",
        secondary: "Automatic, no acting user",
        icon: Cpu,
        seed: "system",
        quiet: true,
      };
  }
}

export type AuditActor = {
  kind: "person" | "machine";
  name: string;
  secondary: string;
  icon: LucideIcon;
  seed: string;
  /** No identifiable actor — set back from the named ones. */
  quiet?: boolean;
};
