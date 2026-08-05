"use client";

import type { McpExecutedAs, McpExecutedAsKind } from "@archestra/shared";
import type { LucideIcon } from "lucide-react";
import { Globe, User, Users } from "lucide-react";
import { scopeStyles } from "@/components/scope-vocabulary";
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
/**
 * An identity that makes calls. A person has a name; a gateway token has none,
 * because it acts for the team or the organization it belongs to.
 */
export type CallerIdentity = {
  name: string | null;
  scope: keyof typeof scopeStyles;
};

export function ExecutedAsBadge({
  executedAs,
  meUserId,
  caller,
}: {
  executedAs: McpExecutedAs | null | undefined;
  /**
   * The reader, so their own identity reads as "Me". Chat passes the viewer;
   * the tool-call log passes nobody, because an auditor reading someone else's
   * call needs the person's name, never "Me".
   */
  meUserId?: string | null;
  /**
   * Who made the call, for the calls the platform ran itself (they carry only
   * the caller's id). Omit where it is unknown; the badge then says "the
   * caller".
   */
  caller?: CallerIdentity | null;
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
  } = describeExecutedAs(executedAs, { meUserId, caller, appName });

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
  caller: CallerIdentity | null | undefined;
  appName: string;
};

// How the reader's own identity reads, matching the resource peels elsewhere.
const SELF_LABEL = "Me";

// An identity the platform served a call for, but could not name.
const UNKNOWN_CALLER = { label: "The caller", possessive: "the caller's" };

// One peel per scope, shared by every identity a call can run as. A gateway
// token is not a fourth kind of thing: it carries the authority of the team or
// the organization it belongs to, so it wears that scope's peel and "called as
// the organization" looks the same in chat and in the tool-call log.
const scopePeels = {
  personal: {
    icon: User,
    style: scopeStyles.personal,
    label: "Personal connection",
    possessive: "their",
  },
  team: {
    icon: Users,
    style: scopeStyles.team,
    label: "Team",
    possessive: "the team's",
  },
  org: {
    icon: Globe,
    style: scopeStyles.org,
    label: "Organization",
    possessive: "the organization's",
  },
} as const;

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
        ...scopePeels.personal,
        label: SELF_LABEL,
        tooltip: "This call used your own connection to the MCP server.",
      };
    }
    const ownerName = executedAs.ownerName;
    return {
      ...scopePeels.personal,
      label: ownerName ?? scopePeels.personal.label,
      tooltip: ownerName
        ? `This call used ${ownerName}'s connection to the MCP server.`
        : "This call used a personal connection whose owner no longer exists.",
    };
  },
  team: (executedAs) => ({
    ...scopePeels.team,
    label: executedAs.teamName ?? scopePeels.team.label,
    tooltip: executedAs.teamName
      ? `This call used the ${executedAs.teamName} team's connection to the MCP server.`
      : "This call used a team connection to the MCP server.",
  }),
  org: () => ({
    ...scopePeels.org,
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
    const display = describeCaller(executedAs.callerUserId, context);
    return { ...display, tooltip: describePlatformCall(display, context) };
  },
};

// The kinds that ran as the calling identity share one peel: that identity's
// own name, or "Me" when the reader is it. A token has no name of its own, so
// it reads as the scope it acts for.
function describeCaller(
  callerUserId: string | null,
  { meUserId, caller }: ExecutedAsContext,
): Omit<ExecutedAsDisplay, "tooltip"> {
  if (!!meUserId && callerUserId === meUserId) {
    return { ...scopePeels.personal, label: SELF_LABEL };
  }
  if (!caller) {
    return { ...scopePeels.personal, label: UNKNOWN_CALLER.label };
  }
  const peel = scopePeels[caller.scope];
  return { ...peel, label: caller.name ?? peel.label };
}

// A platform call reached no MCP server, so the identity is whoever asked for
// it — and their gateway token is how they reach the platform in the first
// place, which is the connection this names.
function describePlatformCall(
  display: Omit<ExecutedAsDisplay, "tooltip">,
  { caller, appName }: ExecutedAsContext,
): string {
  if (display.label === SELF_LABEL) {
    return `This call used your own connection to the ${appName}`;
  }
  return `This call used ${callerPossessive(caller)} own connection to the ${appName}`;
}

function callerPossessive(caller: CallerIdentity | null | undefined): string {
  if (!caller) {
    return UNKNOWN_CALLER.possessive;
  }
  return caller.name ? `${caller.name}'s` : scopePeels[caller.scope].possessive;
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
