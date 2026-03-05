import type { archestraApiTypes } from "@shared";
import { Globe, Mail } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

type InteractionSource =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number]["source"];

const SOURCE_CONFIG: Record<
  NonNullable<InteractionSource>,
  { label: string; icon: ReactNode }
> = {
  api: { label: "API", icon: <Globe className="h-3 w-3 mr-1" /> },
  chat: {
    label: "Chat",
    icon: (
      <Image
        src="/logo.png"
        alt="Chat"
        width={12}
        height={12}
        className="mr-1"
      />
    ),
  },
  "chatops:slack": {
    label: "Slack",
    icon: (
      <Image
        src="/icons/slack.png"
        alt="Slack"
        width={12}
        height={12}
        className="mr-1"
      />
    ),
  },
  "chatops:ms-teams": {
    label: "MS Teams",
    icon: (
      <Image
        src="/icons/ms-teams.png"
        alt="MS Teams"
        width={12}
        height={12}
        className="mr-1"
      />
    ),
  },
  email: { label: "Email", icon: <Mail className="h-3 w-3 mr-1" /> },
};

export function SourceBadge({
  source,
}: {
  source: InteractionSource | null | undefined;
}) {
  if (!source) return null;

  const config = SOURCE_CONFIG[source];

  return (
    <Badge variant="outline" className="text-xs">
      {config.icon}
      {config.label}
    </Badge>
  );
}
