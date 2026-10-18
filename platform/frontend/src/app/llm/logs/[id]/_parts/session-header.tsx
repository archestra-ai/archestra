"use client";

import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIdenticon, PersonAvatar } from "@/app/llm/logs/_parts/hue-avatar";
import {
  type LogSession,
  sourceLabel,
} from "@/app/llm/logs/_parts/logs-table-format";
import {
  describeActor,
  describeSessionOrigin,
  SessionAvatar,
} from "@/app/llm/logs/_parts/session-identity";
import { AgentIcon } from "@/components/agent-icon";
import { SourceIcon } from "@/components/source-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { describeKey } from "@/components/virtual-key-badge";
import { useAppName } from "@/lib/hooks/use-app-name";

/**
 * The session's title behind its composite avatar. From `lg` the 44px avatar
 * fronts both header lines, so it hangs below the title row into the
 * description's gutter; below that it simply leads the title.
 */
export function SessionHeaderTitle({
  session,
  title,
}: {
  session: LogSession | undefined;
  title: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3.5">
      <span className="shrink-0 lg:relative lg:h-8 lg:w-11">
        <span className="block lg:absolute lg:top-1.5 lg:left-0">
          {session ? (
            <SessionHeaderAvatar session={session} />
          ) : (
            <Skeleton className="size-11 rounded-[11px]" />
          )}
        </span>
      </span>
      <span
        title={title}
        className="min-w-0 truncate text-[17px] leading-6 lg:text-xl lg:leading-7"
      >
        {title}
      </span>
    </span>
  );
}

/**
 * "Priya Raman via Claude Code · Slack +2 · [agent] · key", lined up under
 * the title text.
 */
export function SessionIdentityLine({
  session,
}: {
  session: LogSession | undefined;
}) {
  const appName = useAppName();
  if (!session) {
    return (
      <div className={IDENTITY_INSET}>
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
    );
  }
  const { client, primarySource, originLabel } = describeSessionOrigin(session);
  const actor = describeActor(session, appName);
  const showPrimarySource = Boolean(
    client && primarySource && primarySource !== "api",
  );
  const keys = session.virtualKeys ?? [];

  const items: { key: string; node: ReactNode }[] = [
    {
      key: "who",
      node: (
        <span className="inline-flex min-w-0 items-center gap-1">
          {actor.kind === "people" ? (
            <span className="font-medium text-foreground">{actor.label}</span>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <UnstyledButton className="inline-flex cursor-default items-center gap-1 underline decoration-muted-foreground/50 decoration-dotted underline-offset-4">
                  {actor.label}
                </UnstyledButton>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {actor.explanation}
              </TooltipContent>
            </Tooltip>
          )}
          {actor.kind === "people" && actor.names.length > 1 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <UnstyledButton
                  aria-label={`${actor.names.length - 1} more: ${actor.names.slice(1).join(", ")}`}
                  className="cursor-default tabular-nums"
                >
                  +{actor.names.length - 1}
                </UnstyledButton>
              </TooltipTrigger>
              <TooltipContent className="px-2 py-1.5">
                <ul className="space-y-1">
                  {actor.names.map((name, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: two people can share a display name, and the list never reorders.
                    <li key={index} className="flex items-center gap-1.5">
                      <PersonAvatar name={name} size={16} ring={false} />
                      <span>{name}</span>
                    </li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <span className="text-muted-foreground/70">via</span>
          <span className="text-foreground/80">{originLabel}</span>
        </span>
      ),
    },
  ];

  // Only a primary source the client name does not already imply; every
  // other source is listed in the facts card, where it has a label.
  if (showPrimarySource && primarySource) {
    items.push({
      key: "source",
      node: (
        <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
          <SourceIcon source={primarySource} />
          <span>{sourceLabel(primarySource)}</span>
        </span>
      ),
    });
  }

  if (session.profileName) {
    items.push({
      key: "agent",
      node: (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          {/* Infrastructure reads as its type's glyph; an agent keeps the
            identicon the session list gives it. */}
          {session.profileAgentType === "llm_proxy" ||
          session.profileAgentType === "mcp_gateway" ? (
            <AgentIcon
              fallbackType={session.profileAgentType}
              size={14}
              className="text-muted-foreground"
            />
          ) : (
            <AgentIdenticon
              seed={session.profileId ?? session.profileName}
              name={session.profileName}
              variant="agent"
              size="sm"
            />
          )}
          <span className="truncate text-foreground/80">
            {session.profileName}
          </span>
        </span>
      ),
    });
  }

  if (keys.length > 0) {
    const [first] = keys;
    const sharedScope = first.scope === "personal" ? null : first.scope;
    items.push({
      key: "keys",
      node: (
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="inline-flex cursor-default items-center gap-1 text-left hover:text-foreground">
              <KeyRound className="size-3.5 opacity-70" aria-hidden="true" />
              <span className="max-w-[28ch] truncate">{first.name}</span>
              {sharedScope ? (
                <span className="rounded-[4px] bg-muted px-1 text-[10px] leading-[14px]">
                  {sharedScope}
                </span>
              ) : null}
              {keys.length > 1 ? (
                <span className="tabular-nums">+{keys.length - 1}</span>
              ) : null}
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs px-2 py-1.5">
            <div className="space-y-1.5">
              {keys.map((key) => (
                <div key={key.id}>
                  <div className="flex items-center gap-1.5 font-medium">
                    <KeyRound
                      className="size-3 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>{key.name}</span>
                  </div>
                  <div className="pl-[18px] text-muted-foreground">
                    {describeKey(key)} · {key.tokenStart}…
                  </div>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ),
    });
  }

  // Every item leads with its own separator; the row is pulled left by one
  // separator's width and clipped, so the dot that would start a wrapped line
  // is hidden instead of dangling there, and no dot ever ends one.
  return (
    <div className={IDENTITY_INSET}>
      <div className="-my-0.5 overflow-hidden py-0.5">
        <div className="-ml-6 flex flex-wrap items-center gap-y-1 text-sm text-muted-foreground">
          {items.map((item) => (
            // Each item is one unit: it moves to the next line whole
            // rather than breaking inside itself.
            <span
              key={item.key}
              className="inline-flex max-w-full min-w-0 items-center whitespace-nowrap"
            >
              <span
                aria-hidden="true"
                className="w-6 shrink-0 text-center text-muted-foreground/50"
              >
                ·
              </span>
              {item.node}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Lines the identity up under the title text: the back arrow and its gap
 * (32), then the avatar (44) and its gap (14).
 */
const IDENTITY_INSET = "pl-[90px]";

function SessionHeaderAvatar({ session }: { session: LogSession }) {
  const appName = useAppName();
  const { client, primarySource, originLabel } = describeSessionOrigin(session);
  return (
    <SessionAvatar
      client={client}
      source={primarySource}
      originLabel={originLabel}
      actor={describeActor(session, appName)}
      size="lg"
    />
  );
}
