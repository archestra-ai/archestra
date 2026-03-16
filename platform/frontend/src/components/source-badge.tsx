import { INTERACTION_SOURCE_DISPLAY, type InteractionSource } from "@shared";
import { Database, Globe, Mail } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const SOURCE_ICON: Record<InteractionSource, ReactNode> = {
  api: <Globe className="h-3 w-3 shrink-0" />,
  chat: (
    <Image
      src="/logo.png"
      alt="Chat"
      width={12}
      height={12}
      className="shrink-0 rounded-sm"
    />
  ),
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
  "knowledge:embedding": <Database className="h-3 w-3 shrink-0" />,
  "knowledge:reranker": <Database className="h-3 w-3 shrink-0" />,
};

export function SourceIcon({
  source,
}: {
  source: InteractionSource | null | undefined;
}) {
  if (!source) return null;
  return SOURCE_ICON[source];
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
  const _icon = SOURCE_ICON[source];

  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <SourceIcon source={source} />
      <span className="truncate">{display.label}</span>
    </span>
  );
}

export function SourceBadge({
  source,
}: {
  source: InteractionSource | null | undefined;
}) {
  if (!source) return null;

  const _display = INTERACTION_SOURCE_DISPLAY[source];
  const _icon = SOURCE_ICON[source];

  return (
    <Badge variant="outline" className="text-xs">
      <SourceLabel source={source} />
    </Badge>
  );
}
