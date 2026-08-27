"use client";

import { UserX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * Mirrors the API's `unattributedReason`. A blank user is otherwise
 * indistinguishable from a bug, when it almost always means the request
 * arrived on a credential that identifies nobody.
 */
export type UnattributedReason =
  | "shared_virtual_key"
  | "provider_key"
  | "client_credentials"
  | "internal"
  | "unknown";

export function UnattributedUserBadge({
  reason,
}: {
  reason: UnattributedReason | null | undefined;
}) {
  const appName = useAppName();

  // Attributed sessions render their user badges instead. Internal traffic
  // (embeddings, title generation) has no acting user by design — flagging it
  // would be noise on every row.
  if (!reason || reason === "internal") {
    return null;
  }

  const { label, explanation } = describe(reason, appName);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="min-w-0 max-w-full text-xs text-muted-foreground border-dashed"
          >
            <UserX className="h-3 w-3 mr-1 shrink-0" />
            {/* The badge is `w-fit shrink-0`, so without a cap it spills out of
                a narrow table cell into the next column. */}
            <span className="truncate">{label}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <span>{explanation}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function describe(
  reason: Exclude<UnattributedReason, "internal">,
  appName: string,
): { label: string; explanation: string } {
  switch (reason) {
    case "shared_virtual_key":
      return {
        label: "No user — shared key",
        explanation:
          "This request used a team- or organization-scoped virtual key, which belongs to no " +
          "single person. The key itself is named alongside this badge. Only personal virtual " +
          "keys carry an owner, so connect each account individually to attribute usage to people.",
      };
    case "provider_key":
      return {
        label: "No user — provider key",
        explanation:
          `The client sent its own provider credential, so ${appName} never saw a user ` +
          "identity to record. Route the client through a personal virtual key to attribute it.",
      };
    case "client_credentials":
      return {
        label: "No user — machine",
        explanation:
          "Authenticated with an OAuth client-credentials grant, which identifies an " +
          "application rather than a person.",
      };
    default:
      return {
        label: "No user",
        explanation:
          "This request carried no credential identifying a user, so its usage cannot be " +
          "attributed to anyone.",
      };
  }
}
