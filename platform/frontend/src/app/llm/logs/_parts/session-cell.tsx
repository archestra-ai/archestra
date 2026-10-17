"use client";

import {
  type ClientFamily,
  clientForExternalAgentIds,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
} from "@archestra/shared";
import { Bot, Cpu, Globe, KeyRound, Users, UserX } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { ClientIcon } from "@/components/provider-icon";
import { SourceIcon } from "@/components/source-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { UnattributedReason } from "@/components/unattributed-user-badge";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { providerLogoUrl } from "@/lib/provider-logos";
import { cn } from "@/lib/utils/tailwind";
import { PersonAvatar } from "./hue-avatar";
import {
  isKnowledgeSource,
  knowledgeTaskTitle,
  type LogSession,
} from "./logs-table-format";

/**
 * What the session was about, and who ran it through what: the client's tile
 * with the acting person pinned to its corner (an app acting on someone's
 * behalf), then "Priya Raman via Claude Code".
 */
export function SessionCell({ session }: { session: LogSession }) {
  const appName = useAppName();
  const client = clientForExternalAgentIds(session.externalAgentIds);
  const isAppChat = Boolean(session.conversationTitle && session.sessionId);
  const sources = uniqueSources(session);
  const primarySource = session.source ?? sources[0] ?? null;
  const isKnowledge = isKnowledgeSource(primarySource);

  const placeholder = session.contentNotStored
    ? "Content not stored"
    : "No message";
  // Server-computed preview: the sessions API never returns raw request
  // bodies (shipping them OOM-killed the platform container, T-1015).
  const preview =
    session.claudeCodeTitle || session.lastUserMessagePreview || "";
  const title = isAppChat
    ? (session.conversationTitle ?? "")
    : preview ||
      (isKnowledgeSource(primarySource)
        ? knowledgeTaskTitle(primarySource)
        : placeholder);
  const isPlaceholder = title === placeholder;

  const originLabel = isKnowledge
    ? "Knowledge base"
    : (client?.label ??
      (primarySource ? sourceLabel(primarySource) : "API request"));
  const actor = describeActor(session, appName);
  const extraSources = sources.filter((source) => source !== primarySource);

  return (
    <div className="flex min-w-0 items-center gap-3.5">
      <CompositeAvatar
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
        <div className="flex h-4 min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
          <span
            className={cn(
              "min-w-0 truncate",
              actor.kind === "people" && "text-foreground/80",
            )}
          >
            {actor.label}
          </span>
          {actor.kind === "people" && actor.names.length > 1 ? (
            <span className="shrink-0 tabular-nums">
              +{actor.names.length - 1}
            </span>
          ) : null}
          <span className="shrink-0 text-muted-foreground/70">via</span>
          <span className="shrink-0 truncate">{originLabel}</span>
          {client && primarySource && primarySource !== "api" ? (
            <>
              <Dot />
              <span className="truncate">{sourceLabel(primarySource)}</span>
            </>
          ) : null}
          {extraSources.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <UnstyledButton
                  aria-label={`Also includes ${extraSources.map(sourceLabel).join(", ")}`}
                  className="ml-0.5 shrink-0 cursor-default rounded-sm px-1 tabular-nums ring-1 ring-border ring-inset hover:text-foreground"
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
              <Dot />
              <Link
                href={`/chat/${session.sessionId}`}
                onClick={(event) => event.stopPropagation()}
                className="shrink-0 font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
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

type Actor =
  | { kind: "people"; names: string[]; label: string }
  | {
      kind: "nobody";
      reason: UnattributedReason;
      label: string;
      explanation: string;
    };

/** The client tile with the acting person (or a stand-in) on its corner. */
function CompositeAvatar({
  client,
  source,
  originLabel,
  actor,
}: {
  client: ClientFamily | null;
  source: InteractionSource | null;
  originLabel: string;
  actor: Actor;
}) {
  const others =
    actor.kind === "people" && actor.names.length > 1
      ? ` and ${actor.names.length - 1} other${actor.names.length > 2 ? "s" : ""}`
      : "";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`${actor.label}${others} via ${originLabel}`}
          className="relative block size-9 shrink-0 cursor-default"
        >
          <ClientTile client={client} source={source} />
          <span className="absolute -right-1.5 -bottom-1.5 flex">
            <ActorBadge actor={actor} />
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs px-2.5 py-2">
        {actor.kind === "people" ? (
          <>
            <div className="mb-1.5 text-muted-foreground">
              {actor.names.length > 1
                ? `${actor.names.length} people via ${originLabel}`
                : `Via ${originLabel}`}
            </div>
            <ul className="space-y-1">
              {actor.names.map((name, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two people can share a display name, and the list never reorders.
                <li key={index} className="flex items-center gap-1.5">
                  <PersonAvatar name={name} size={18} ring={false} />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="mb-1.5 text-muted-foreground">
              {`${actor.label} via ${originLabel}`}
            </div>
            <p className="leading-snug">{actor.explanation}</p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function ClientTile({
  client,
  source,
}: {
  client: ClientFamily | null;
  source: InteractionSource | null;
}) {
  const appIconLogo = useAppIconLogo();
  if (client?.mark) {
    // Mark clients bring their own branded tile.
    return <ClientIcon client={client} size={36} />;
  }

  let logo: { src: string; alt: string; size: number; invert: boolean } | null =
    null;
  if (client) {
    logo = {
      src: client.icon ?? providerLogoUrl(client.provider),
      alt: client.label,
      size: 18,
      invert: true,
    };
  } else if (source === "chat") {
    logo = { src: appIconLogo, alt: "Chat", size: 20, invert: false };
  } else if (source && source in CHATOPS_LOGOS) {
    logo = CHATOPS_LOGOS[source as keyof typeof CHATOPS_LOGOS];
  }

  return (
    <span className="flex size-9 items-center justify-center rounded-[9px] border border-border/70 bg-gradient-to-b from-background to-muted/70 text-foreground/70 [&_svg]:size-4">
      {logo ? (
        <Image
          src={logo.src}
          alt={logo.alt}
          width={logo.size}
          height={logo.size}
          className={cn(
            "shrink-0 rounded-md object-contain",
            logo.invert && "dark:invert",
          )}
        />
      ) : source ? (
        <SourceIcon source={source} />
      ) : (
        <Globe aria-hidden="true" />
      )}
    </span>
  );
}

const CHATOPS_LOGOS = {
  "chatops:slack": {
    src: "/icons/slack.png",
    alt: "Slack",
    size: 18,
    invert: false,
  },
  "chatops:ms-teams": {
    src: "/icons/ms-teams.png",
    alt: "Microsoft Teams",
    size: 18,
    invert: false,
  },
  "chatops:telegram": {
    src: "/icons/telegram.png",
    alt: "Telegram",
    size: 18,
    invert: false,
  },
} as const;

function ActorBadge({ actor }: { actor: Actor }) {
  if (actor.kind === "people") {
    const [first, second] = actor.names;
    return (
      <span className="flex">
        {second ? (
          <span className="-mr-2.5 opacity-90">
            <PersonAvatar name={second} size={18} />
          </span>
        ) : null}
        <span className="relative">
          <PersonAvatar name={first} size={18} />
        </span>
      </span>
    );
  }
  const Icon = UNATTRIBUTED_ICONS[actor.reason];
  return (
    <span
      className={cn(
        "flex size-[18px] items-center justify-center rounded-full ring-2 ring-background",
        actor.reason === "internal"
          ? "bg-muted text-muted-foreground"
          : "border border-dashed border-muted-foreground/60 bg-background text-muted-foreground",
      )}
    >
      <Icon className="size-2.5" strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
      ·
    </span>
  );
}

const UNATTRIBUTED_ICONS: Record<UnattributedReason, typeof Bot> = {
  internal: Cpu,
  shared_virtual_key: Users,
  provider_key: KeyRound,
  client_credentials: Bot,
  unknown: UserX,
};

/**
 * Who a session ran as, or why nobody: a blank user is otherwise
 * indistinguishable from a bug, when it almost always means the request
 * arrived on a credential that identifies nobody.
 */
function describeActor(session: LogSession, appName: string): Actor {
  const names = session.userNames;
  if (names.length > 0) {
    return { kind: "people", names, label: names[0] };
  }
  const reason = session.unattributedReason ?? "unknown";
  switch (reason) {
    case "internal":
      return {
        kind: "nobody",
        reason,
        label: "System",
        explanation: `Internal ${appName} traffic, such as embeddings and title generation, has no acting user.`,
      };
    case "shared_virtual_key":
      return {
        kind: "nobody",
        reason,
        label: "Shared key",
        explanation:
          "This request used a team- or organization-scoped virtual key, which belongs to no single person. Only personal virtual keys carry an owner.",
      };
    case "provider_key":
      return {
        kind: "nobody",
        reason,
        label: "Provider key",
        explanation: `The client sent its own provider credential, so ${appName} never saw a user identity. Route the client through a personal virtual key to attribute it.`,
      };
    case "client_credentials":
      return {
        kind: "nobody",
        reason,
        label: "Machine",
        explanation:
          "Authenticated with an OAuth client-credentials grant, which identifies an application rather than a person.",
      };
    default:
      return {
        kind: "nobody",
        reason: "unknown",
        label: "Unattributed",
        explanation:
          "This request carried no credential identifying a user, so its usage cannot be attributed to anyone.",
      };
  }
}

function uniqueSources(session: LogSession): InteractionSource[] {
  return Array.from(
    new Set(
      (session.sources ?? []).filter((source): source is InteractionSource =>
        Boolean(source),
      ),
    ),
  );
}

function sourceLabel(source: InteractionSource): string {
  return INTERACTION_SOURCE_DISPLAY[source]?.label ?? source;
}
