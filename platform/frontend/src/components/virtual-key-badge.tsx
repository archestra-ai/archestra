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
 * One line of prose per key: what kind it is, and who it belongs to.
 *
 * A personal key belongs to its owner, and that owner is who the request is
 * attributed to. A shared key attributes to nobody — but it is not anonymous,
 * so it says what it *is* shared with: the named teams for a team key, the
 * organization plus whoever set it up for an org key.
 */
export function describeKey(key: VirtualKey): string {
  const kind =
    key.keyType === "passthrough" ? "Passthrough key" : "Virtual key";

  return `${kind} · ${describeAssociation(key)}`;
}

function describeAssociation(key: VirtualKey): string {
  if (key.scope === "personal") {
    // `author_id` is ON DELETE SET NULL, so a personal key can outlive its
    // owner. Saying "shared" there would be wrong.
    return key.ownerUserName ?? "owner removed";
  }

  if (key.scope === "team") {
    if (key.teams.length > 0) {
      const names = key.teams.map((team) => team.name).join(", ");
      return `shared with ${names}`;
    }
    // Team-scoped with every assignment removed: nobody reaches it, which is
    // worth saying plainly rather than rendering as a bare "shared".
    return "team key, no team assigned";
  }

  return key.createdByUserName
    ? `shared org-wide, created by ${key.createdByUserName}`
    : "shared org-wide";
}
