"use client";

import type { McpExecutedAs, McpExecutedAsKind } from "@archestra/shared";
import type { LucideIcon } from "lucide-react";
import { Globe, KeyRound, User, Users } from "lucide-react";
import { scopeStyles } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

/**
 * Names the identity whose credential served a tool call upstream, so a tool
 * call answers "on whose behalf did this run?" — the caller's own connection, a
 * team or organization connection, a connection an admin pinned as a service
 * account, or a token minted for the caller.
 *
 * Renders nothing when the call resolved no upstream credential (a platform
 * built-in, a blocked call) or predates the descriptor.
 */
export function ExecutedAsBadge({
  executedAs,
  meUserId,
  callerName,
}: {
  executedAs: McpExecutedAs | null | undefined;
  /**
   * Whose perspective "Me" is written from: the viewer in chat, the recorded
   * caller in the tool-call log. Omit to always name the owner.
   */
  meUserId?: string | null;
  /**
   * Display name of the user who made the call, for the calls the platform ran
   * itself (they carry only the caller's id). Omit where it is unknown; the
   * badge then says "the caller".
   */
  callerName?: string | null;
}) {
  const appName = useAppName();

  if (!executedAs) {
    return null;
  }

  const {
    icon: Icon,
    style,
    label,
    tooltip,
  } = describeExecutedAs(executedAs, { meUserId, callerName, appName });

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={cn(
              style,
              "inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs font-normal",
            )}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type ExecutedAsDisplay = {
  icon: LucideIcon;
  style: string;
  label: string;
  tooltip: string;
};

type ExecutedAsContext = {
  meUserId: string | null | undefined;
  callerName: string | null | undefined;
  appName: string;
};

// How the reader's own identity reads, matching the resource peels elsewhere.
const SELF_LABEL = "Me";

// One entry per identity kind. The peel names the identity itself — the
// surrounding column header or label says what the name means — so it reads
// like the scope peels on the apps, projects and skills lists.
const executedAsDescriptors: {
  [K in McpExecutedAsKind]: (
    executedAs: Extract<McpExecutedAs, { kind: K }>,
    context: ExecutedAsContext,
  ) => ExecutedAsDisplay;
} = {
  personal: (executedAs, { meUserId }) => {
    const isMe = !!meUserId && executedAs.ownerUserId === meUserId;
    if (isMe) {
      return {
        icon: User,
        style: scopeStyles.personal,
        label: SELF_LABEL,
        tooltip: "This call used your own connection to the MCP server.",
      };
    }
    const ownerName = executedAs.ownerName;
    return {
      icon: User,
      style: scopeStyles.personal,
      label: ownerName ?? "Personal connection",
      tooltip: ownerName
        ? `This call used ${ownerName}'s connection to the MCP server.`
        : "This call used a personal connection whose owner no longer exists.",
    };
  },
  team: (executedAs) => ({
    icon: Users,
    style: scopeStyles.team,
    label: executedAs.teamName ?? "Team",
    tooltip: executedAs.teamName
      ? `This call used the ${executedAs.teamName} team's connection to the MCP server.`
      : "This call used a team connection to the MCP server.",
  }),
  org: () => ({
    icon: Globe,
    style: scopeStyles.org,
    label: "Organization",
    tooltip:
      "This call used the organization-wide connection to the MCP server.",
  }),
  idp_exchange: (executedAs, context) => ({
    ...describeCaller(executedAs.callerUserId, context),
    tooltip:
      "The identity provider issued a credential for the calling user, so the MCP server saw them.",
  }),
  idp_passthrough: (executedAs, context) => ({
    ...describeCaller(executedAs.callerUserId, context),
    tooltip:
      "The calling user's own sign-in token was forwarded to the MCP server.",
  }),
  caller_headers: (executedAs, context) => ({
    ...describeCaller(executedAs.callerUserId, context),
    tooltip:
      "The calling client supplied the credential the MCP server was called with.",
  }),
  platform: (executedAs, context) => {
    const caller = describeCaller(executedAs.callerUserId, context);
    return {
      ...caller,
      tooltip:
        caller.label === SELF_LABEL
          ? `This call used your own connection to the ${context.appName}`
          : `This call used ${caller.label}'s own connection to the ${context.appName}`,
    };
  },
};

// The kinds that ran as the calling user share one peel: their own name, or
// "Me" when the reader is that user.
function describeCaller(
  callerUserId: string | null,
  { meUserId, callerName }: ExecutedAsContext,
): Omit<ExecutedAsDisplay, "tooltip"> {
  const isMe = !!meUserId && callerUserId === meUserId;
  return {
    icon: User,
    style: scopeStyles.personal,
    label: isMe ? SELF_LABEL : (callerName ?? "The caller"),
  };
}

function describeExecutedAs(
  executedAs: McpExecutedAs,
  context: ExecutedAsContext,
): ExecutedAsDisplay {
  // Narrowed per kind by the descriptor table's mapped type; the lookup itself
  // needs the cast because TypeScript cannot correlate key and value here.
  const describe = executedAsDescriptors[executedAs.kind] as (
    executedAs: McpExecutedAs,
    context: ExecutedAsContext,
  ) => ExecutedAsDisplay;
  return describe(executedAs, context);
}
