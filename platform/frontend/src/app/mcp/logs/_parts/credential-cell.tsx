"use client";

import { extractMcpExecutedAs, type McpExecutedAs } from "@archestra/shared";
import {
  Boxes,
  Globe,
  KeyRound,
  type LucideIcon,
  User,
  Users,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatAuthMethod } from "@/lib/mcp/mcp-tool-call.query";
import { cn } from "@/lib/utils/tailwind";
import type { McpToolCallRow } from "./types";

/**
 * Whose credential served the call upstream, then how the caller reached the
 * gateway. Said only in terms that add information: the caller's own
 * connection reads "Own connection", never their name a second time.
 */
export function CredentialCell({ row }: { row: McpToolCallRow }) {
  const credential = describeCredential(
    extractMcpExecutedAs(row.toolResult),
    row,
  );
  const auth = row.authMethod ? formatAuthMethod(row.authMethod) : null;
  if (!credential && !auth) {
    return <div className="text-xs text-muted-foreground">—</div>;
  }
  // With no upstream credential recorded, the gateway auth is the only fact,
  // so it moves up to the primary line instead of a "none" placeholder.
  const Icon = credential?.icon ?? KeyRound;
  const primary = credential?.label ?? auth ?? "Unknown auth";
  const secondary = credential
    ? auth
      ? `via ${auth}`
      : null
    : "No upstream credential";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton className="block w-full min-w-0 cursor-default text-left">
          <span
            className={cn(
              "flex h-5 min-w-0 items-center gap-1.5 text-sm leading-5 font-medium",
              credential?.quiet && "font-normal text-foreground/80",
            )}
          >
            <Icon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate">{primary}</span>
          </span>
          {secondary ? (
            <span className="block truncate pl-5 text-xs leading-4 text-muted-foreground">
              {secondary}
            </span>
          ) : null}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 px-2 py-1.5">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          <dt className="text-muted-foreground">Gateway auth</dt>
          <dd className="text-right">{auth ?? "—"}</dd>
          <dt className="text-muted-foreground">Upstream</dt>
          <dd className="text-right">{credential?.label ?? "None"}</dd>
        </dl>
        {credential ? (
          <p className="mt-1.5 leading-snug text-muted-foreground">
            {credential.explanation}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

type CredentialDisplay = {
  icon: LucideIcon;
  label: string;
  explanation: string;
  /** The unremarkable case, set back so the exceptions stand out. */
  quiet?: boolean;
};

function describeCredential(
  executedAs: McpExecutedAs | null,
  row: Pick<McpToolCallRow, "userId">,
): CredentialDisplay | null {
  if (!executedAs) return null;
  switch (executedAs.kind) {
    case "personal": {
      const owner = executedAs.ownerName;
      if (executedAs.ownerUserId && executedAs.ownerUserId === row.userId) {
        return {
          icon: User,
          label: "Own connection",
          explanation:
            "This call used the caller's own connection to the MCP server.",
          quiet: true,
        };
      }
      return owner
        ? {
            icon: User,
            label: `${owner}'s connection`,
            explanation: `This call used ${owner}'s personal connection to the MCP server.`,
          }
        : {
            icon: User,
            label: "Personal connection",
            explanation:
              "This call used a personal connection whose owner no longer exists.",
          };
    }
    case "team":
      return {
        icon: Users,
        label: executedAs.teamName ?? "Team connection",
        explanation: "This call used a team connection to the MCP server.",
      };
    case "org":
      return {
        icon: Globe,
        label: "Organization",
        explanation:
          "This call used the organization-wide connection to the MCP server.",
      };
    case "idp_exchange":
      return {
        icon: KeyRound,
        label: "IdP-minted token",
        explanation:
          "The identity provider issued a credential for the caller, so the MCP server saw them.",
      };
    case "idp_passthrough":
      return {
        icon: KeyRound,
        label: "Forwarded sign-in",
        explanation:
          "The caller's own sign-in token was forwarded to the MCP server.",
      };
    case "caller_headers":
      return {
        icon: KeyRound,
        label: "Client-supplied",
        explanation:
          "The calling client supplied the credential the MCP server was called with.",
      };
    case "platform":
      return {
        icon: Boxes,
        label: "Built-in",
        explanation:
          "Served by the platform itself with the caller's own permissions; no MCP server credential was involved.",
        quiet: true,
      };
  }
}
