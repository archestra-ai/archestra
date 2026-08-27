"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type VirtualKey = archestraApiTypes.InteractionVirtualKey;

/**
 * Names the virtual key a request authenticated with. Per-user attribution is
 * the reason virtual keys exist, so "Auth Method: Virtual Key" on its own —
 * which is all the logs used to say — answers the least useful half of the
 * question.
 *
 * A key that stands for someone (a personal key) names them; a shared one says
 * so, which is a real answer rather than a blank.
 */
export function VirtualKeyBadge({
  virtualKeys,
  className,
}: {
  virtualKeys: VirtualKey[] | null | undefined;
  className?: string;
}) {
  if (!virtualKeys || virtualKeys.length === 0) {
    return null;
  }

  const [first, ...rest] = virtualKeys;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={`min-w-0 max-w-full text-xs font-normal text-muted-foreground ${className ?? ""}`}
          >
            <KeyRound className="h-3 w-3 mr-1 shrink-0" />
            <span className="truncate">{first.name}</span>
            {rest.length > 0 ? (
              <span className="ml-1 shrink-0">+{rest.length}</span>
            ) : null}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="space-y-2">
            {virtualKeys.map((key) => (
              <div key={key.id} className="space-y-0.5">
                <div className="font-medium">{key.name}</div>
                <div className="text-xs">
                  {describeKey(key)} · {key.tokenStart}…
                </div>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * One line of prose per key: what kind it is, and who it stands for. Only a
 * personal key carries an owner — a team- or org-scoped key is shared by
 * design, so it attributes to nobody and saying so is the answer.
 */
export function describeKey(key: VirtualKey): string {
  const kind =
    key.keyType === "passthrough" ? "Passthrough key" : "Virtual key";

  if (key.ownerUserName) {
    return `${kind} · ${key.ownerUserName}`;
  }
  if (key.scope === "personal") {
    // Personal, but the owner's account is gone (author_id is ON DELETE SET
    // NULL). Saying "shared" here would be wrong.
    return `${kind} · owner removed`;
  }
  return `${kind} · shared, no owner`;
}
