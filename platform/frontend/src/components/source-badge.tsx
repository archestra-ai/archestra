import { INTERACTION_SOURCE_DISPLAY, type InteractionSource } from "@shared";
import { CalendarClock, Database, Globe, Mail } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

export function SourceIcon({
  source,
}: {
  source: InteractionSource | null | undefined;
}) {
  const appIconLogo = useAppIconLogo();

  if (!source) return null;

  return getSourceIcon({
    source,
    chatIconLogo: appIconLogo,
  });
}

export function SourceLabel({
  source,
  className,
}: {
  source: InteractionSource | null | undefined;
  className?: string;
}) {
  if (!source) return null;

  const display = INTERACTION_SOURCE_DISPLAY[source];

  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <SourceIcon source={source} />
      <span className="truncate">{display.label}</span>
    </span>
  );
}

export function SourceBadge({
  source,
  className,
  labelClassName,
}: {
  source: InteractionSource | null | undefined;
  className?: string;
  labelClassName?: string;
}) {
  if (!source) return null;

  return (
    <Badge variant="outline" className={cn("max-w-full text-xs", className)}>
      <SourceLabel
        source={source}
        className={cn("max-w-full", labelClassName)}
      />
    </Badge>
  );
}

function getSourceIcon({
  source,
  chatIconLogo,
}: {
  source: InteractionSource;
  chatIconLogo: string;
}): ReactNode {
  if (source === "chat") {
    return (
      <Image
        src={chatIconLogo}
        alt="Chat"
        width={12}
        height={12}
        className="shrink-0 rounded-sm"
      />
    );
  }

  const sourceIcon: Record<Exclude<InteractionSource, "chat">, ReactNode> = {
    api: <Globe className="h-3 w-3 shrink-0" />,
    "chatops:slack": (
      <Image
        src="/icons/slack.png"
        alt="Slack"
        width={12}
        height={12}
        className="shrink-0 rounded-sm"
      />
    ),
    "chatops:ms-teams": (
      <Image
        src="/icons/ms-teams.png"
        alt="MS Teams"
        width={12}
        height={12}
        className="shrink-0 rounded-sm"
      />
    ),
    email: <Mail className="h-3 w-3 shrink-0" />,
    "schedule-trigger": <CalendarClock className="h-3 w-3 shrink-0" />,
    "knowledge:embedding": <Database className="h-3 w-3 shrink-0" />,
    "knowledge:reranker": <Database className="h-3 w-3 shrink-0" />,
    "knowledge:query-expansion": <Database className="h-3 w-3 shrink-0" />,
  };

  return sourceIcon[source];
}
