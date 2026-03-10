import { INTERACTION_SOURCE_DISPLAY, type InteractionSource } from "@shared";
import { Database, Globe, Mail } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

const SOURCE_ICON: Record<InteractionSource, ReactNode> = {
  api: <Globe className="h-3 w-3 mr-1" />,
  chat: (
    <Image src="/logo.png" alt="Chat" width={12} height={12} className="mr-1" />
  ),
  "chatops:slack": (
    <Image
      src="/icons/slack.png"
      alt="Slack"
      width={12}
      height={12}
      className="mr-1"
    />
  ),
  "chatops:ms-teams": (
    <Image
      src="/icons/ms-teams.png"
      alt="MS Teams"
      width={12}
      height={12}
      className="mr-1"
    />
  ),
  email: <Mail className="h-3 w-3 mr-1" />,
  "knowledge:embedding": <Database className="h-3 w-3 mr-1" />,
  "knowledge:reranker": <Database className="h-3 w-3 mr-1" />,
};

export function SourceBadge({
  source,
}: {
  source: InteractionSource | null | undefined;
}) {
  if (!source) return null;

  const display = INTERACTION_SOURCE_DISPLAY[source];
  const icon = SOURCE_ICON[source];

  return (
    <Badge variant="outline" className="text-xs">
      {icon}
      {display.label}
    </Badge>
  );
}
