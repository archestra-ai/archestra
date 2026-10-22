"use client";

import {
  type ClientFamily,
  clientForExternalAgentIds,
  type InteractionSource,
} from "@archestra/shared";
import { Bot, Cpu, Globe, KeyRound, Users, UserX } from "lucide-react";
import Image from "next/image";
import { ClientIcon } from "@/components/provider-icon";
import { SourceIcon } from "@/components/source-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { UnattributedReason } from "@/components/unattributed-user-badge";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { providerLogoUrl } from "@/lib/provider-logos";
import { cn } from "@/lib/utils/tailwind";
import { PersonAvatar } from "./hue-avatar";
import {
  isKnowledgeSource,
  type LogSession,
  sourceLabel,
  uniqueSources,
} from "./logs-table-format";

// Who ran a session and through what, shared by the logs table's Session cell
// and the session page's header: the client's tile with the acting person
// pinned to its corner, and the "Priya Raman via Claude Code" words for it.

type IdentitySession = Pick<
  LogSession,
  "externalAgentIds" | "source" | "sources" | "userNames" | "unattributedReason"
>;

export type Actor =
  | { kind: "people"; names: string[]; label: string }
  | {
      kind: "nobody";
      reason: UnattributedReason;
      label: string;
      explanation: string;
    };

/** The client a session came through, its main source, and what to call it. */
export function describeSessionOrigin(session: IdentitySession): {
  client: ClientFamily | null;
  primarySource: InteractionSource | null;
  originLabel: string;
  /** Every other source that wrote to the session. */
  extraSources: InteractionSource[];
} {
  const client = clientForExternalAgentIds(session.externalAgentIds ?? []);
  const sources = uniqueSources(session);
  const primarySource = session.source ?? sources[0] ?? null;
  const originLabel = isKnowledgeSource(primarySource)
    ? "Knowledge base"
    : (client?.label ??
      (primarySource ? sourceLabel(primarySource) : "API request"));
  return {
    client,
    primarySource,
    originLabel,
    extraSources: sources.filter((source) => source !== primarySource),
  };
}

/**
 * Who a session ran as, or why nobody: a blank user is otherwise
 * indistinguishable from a bug, when it almost always means the request
 * arrived on a credential that identifies nobody.
 */
export function describeActor(
  session: Pick<IdentitySession, "userNames" | "unattributedReason"> & {
    source?: IdentitySession["source"];
  },
  appName: string,
): Actor {
  const names = session.userNames ?? [];
  if (names.length > 0) {
    return { kind: "people", names, label: names[0] };
  }
  // Knowledge work (embedding, reranking, OCR) is the platform's own
  // background traffic, whatever credential it happened to log.
  const reason =
    session.source && isKnowledgeSource(session.source)
      ? "internal"
      : (session.unattributedReason ?? "unknown");
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

/**
 * The client tile with the acting person (or a stand-in) on its corner, and
 * a tooltip naming everyone involved. `md` fronts a table row; `lg` fronts a
 * page header's two lines.
 */
export function SessionAvatar({
  client,
  source,
  originLabel,
  actor,
  size = "md",
}: {
  client: ClientFamily | null;
  source: InteractionSource | null;
  originLabel: string;
  actor: Actor;
  size?: AvatarSize;
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
          className={cn(
            "relative block shrink-0 cursor-default",
            AVATAR_SIZES[size].frame,
          )}
        >
          <ClientTile client={client} source={source} size={size} />
          <span className="absolute -right-1.5 -bottom-1.5 flex">
            <ActorBadge actor={actor} size={AVATAR_SIZES[size].badge} />
          </span>
        </UnstyledButton>
      </TooltipTrigger>
      {/* A wrapped line never shrinks its box back, so a wide cap left a
          strip of dead space; this width fits the explanations' wrap. */}
      <TooltipContent className="max-w-64 px-2.5 py-2">
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
            <p className="leading-snug text-pretty">{actor.explanation}</p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The client's (or source's) mark alone, for a detail page's icon tile, which
 * draws its own frame: the acting person is named in the line beside it.
 */
export function SessionClientMark({
  client,
  source,
}: {
  client: ClientFamily | null;
  source: InteractionSource | null;
}) {
  const appIconLogo = useAppIconLogo();
  if (client?.mark) return <ClientIcon client={client} size={24} />;
  const logo = client
    ? {
        src: client.icon ?? providerLogoUrl(client.provider),
        alt: client.label,
        invert: true,
      }
    : source === "chat"
      ? { src: appIconLogo, alt: "Chat", invert: false }
      : source && source in CHATOPS_LOGOS
        ? {
            ...CHATOPS_LOGOS[source as keyof typeof CHATOPS_LOGOS],
            invert: false,
          }
        : null;
  if (logo) {
    return (
      <Image
        src={logo.src}
        alt={logo.alt}
        width={20}
        height={20}
        className={cn("object-contain", logo.invert && "dark:invert")}
      />
    );
  }
  return source ? <SourceIcon source={source} /> : <Globe aria-hidden="true" />;
}

// ============================================================================
// Internal helpers
// ============================================================================

type AvatarSize = "md" | "lg";

const AVATAR_SIZES: Record<
  AvatarSize,
  {
    frame: string;
    tile: string;
    mark: number;
    logo: number;
    chatLogo: number;
    badge: number;
  }
> = {
  md: {
    frame: "size-9",
    tile: "size-9 rounded-[9px] [&_svg]:size-4",
    mark: 36,
    logo: 18,
    chatLogo: 20,
    badge: 18,
  },
  lg: {
    frame: "size-11",
    tile: "size-11 rounded-[11px] [&_svg]:size-5",
    mark: 44,
    logo: 22,
    chatLogo: 24,
    badge: 20,
  },
};

function ClientTile({
  client,
  source,
  size,
}: {
  client: ClientFamily | null;
  source: InteractionSource | null;
  size: AvatarSize;
}) {
  const appIconLogo = useAppIconLogo();
  const dims = AVATAR_SIZES[size];
  if (client?.mark) {
    // Mark clients bring their own branded tile.
    return <ClientIcon client={client} size={dims.mark} />;
  }

  let logo: { src: string; alt: string; size: number; invert: boolean } | null =
    null;
  if (client) {
    logo = {
      src: client.icon ?? providerLogoUrl(client.provider),
      alt: client.label,
      size: dims.logo,
      invert: true,
    };
  } else if (source === "chat") {
    logo = {
      src: appIconLogo,
      alt: "Chat",
      size: dims.chatLogo,
      invert: false,
    };
  } else if (source && source in CHATOPS_LOGOS) {
    const chatops = CHATOPS_LOGOS[source as keyof typeof CHATOPS_LOGOS];
    logo = { ...chatops, size: dims.logo, invert: false };
  }

  return (
    <span
      className={cn(
        "flex items-center justify-center border border-border/70 bg-gradient-to-b from-background to-muted/70 text-foreground/70",
        dims.tile,
      )}
    >
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
  "chatops:slack": { src: "/icons/slack.png", alt: "Slack" },
  "chatops:ms-teams": { src: "/icons/ms-teams.png", alt: "Microsoft Teams" },
  "chatops:telegram": { src: "/icons/telegram.png", alt: "Telegram" },
} as const;

function ActorBadge({ actor, size }: { actor: Actor; size: number }) {
  if (actor.kind === "people") {
    const [first, second] = actor.names;
    return (
      <span className="flex">
        {second ? (
          <span className="-mr-2.5 opacity-90">
            <PersonAvatar name={second} size={size} />
          </span>
        ) : null}
        <span className="relative">
          <PersonAvatar name={first} size={size} />
        </span>
      </span>
    );
  }
  const Icon = UNATTRIBUTED_ICONS[actor.reason];
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-full ring-2 ring-background",
        actor.reason === "internal"
          ? "bg-muted text-muted-foreground"
          : "border border-dashed border-muted-foreground/60 bg-background text-muted-foreground",
      )}
      style={{ width: size, height: size }}
    >
      <Icon className="size-2.5" strokeWidth={2.25} aria-hidden="true" />
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
