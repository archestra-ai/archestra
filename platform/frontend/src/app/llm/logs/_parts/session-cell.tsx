"use client";

import Link from "next/link";
import { SourceIcon } from "@/components/source-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";
import {
  isKnowledgeSource,
  knowledgeTaskTitle,
  type LogSession,
  sessionTitleOf,
  sourceLabel,
} from "./logs-table-format";
import {
  describeActor,
  describeSessionOrigin,
  SessionAvatar,
} from "./session-identity";

/**
 * What the session was about, and who ran it through what: the client's tile
 * with the acting person pinned to its corner (an app acting on someone's
 * behalf), then "Priya Raman via Claude Code".
 */
export function SessionCell({ session }: { session: LogSession }) {
  const appName = useAppName();
  const { client, primarySource, originLabel, extraSources } =
    describeSessionOrigin(session);
  const isAppChat = Boolean(session.conversationTitle && session.sessionId);

  // A session whose latest turns carry no user text (a client mid tool loop,
  // or one whose preview was never captured) is still a session of something:
  // name it by the client rather than calling a busy session empty.
  const placeholder = session.contentNotStored
    ? "Content not stored"
    : `${originLabel} session`;
  // Server-computed preview: the sessions API never returns raw request
  // bodies (shipping them OOM-killed the platform container, T-1015).
  const preview = sessionTitleOf({
    claudeCodeTitle: session.claudeCodeTitle,
    lastUserMessagePreview: session.lastUserMessagePreview,
  });
  const title = isAppChat
    ? (session.conversationTitle ?? "")
    : (preview ??
      (isKnowledgeSource(primarySource)
        ? knowledgeTaskTitle(primarySource)
        : placeholder));
  const isPlaceholder = title === placeholder;

  const actor = describeActor(session, appName);

  return (
    <div className="flex min-w-0 items-center gap-3.5 pr-4">
      <SessionAvatar
        client={client}
        source={primarySource}
        originLabel={originLabel}
        actor={actor}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm leading-5 font-medium",
            isPlaceholder && "font-normal italic text-muted-foreground",
          )}
          title={isPlaceholder ? undefined : title}
        >
          {title}
        </div>
        {/* One inline run that truncates as a whole: as flex items the
            parts each kept their width, so a narrow column let "via …" run
            on into the next one. */}
        <div className="h-4 truncate text-xs leading-4 text-muted-foreground">
          <span className={cn(actor.kind === "people" && "text-foreground/80")}>
            {actor.label}
          </span>
          {actor.kind === "people" && actor.names.length > 1 ? (
            <span className="tabular-nums"> +{actor.names.length - 1}</span>
          ) : null}{" "}
          <span className="text-muted-foreground/70">via</span>{" "}
          <span>{originLabel}</span>
          {client && primarySource && primarySource !== "api" ? (
            <>
              {" "}
              <Dot /> <span>{sourceLabel(primarySource)}</span>
            </>
          ) : null}
          {extraSources.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <UnstyledButton
                  aria-label={`Also includes ${extraSources.map(sourceLabel).join(", ")}`}
                  className="ml-1 cursor-default rounded-sm px-1 tabular-nums ring-1 ring-border ring-inset hover:text-foreground"
                >
                  +{extraSources.length}
                </UnstyledButton>
              </TooltipTrigger>
              <TooltipContent className="px-2 py-1.5">
                <div className="mb-1 text-muted-foreground">Also includes</div>
                <ul className="space-y-0.5">
                  {extraSources.map((source) => (
                    <li key={source} className="flex items-center gap-1.5">
                      <SourceIcon source={source} />
                      <span>{sourceLabel(source)}</span>
                    </li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {isAppChat ? (
            <>
              {" "}
              <Dot />{" "}
              <Link
                href={`/chat/${session.sessionId}`}
                onClick={(event) => event.stopPropagation()}
                className="font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              >
                Open chat
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}
