"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { MessageSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { buildAppChatHandoffUrl } from "@/lib/apps/app-chat-handoff";

type App = archestraApiTypes.GetAppResponses["200"];

export function AppChatButton({ app }: { app: App }) {
  const router = useRouter();

  return (
    <Button
      variant="outline"
      onClick={() =>
        router.push(
          buildAppChatHandoffUrl({ appId: app.id, appName: app.name }),
        )
      }
    >
      <MessageSquare className="h-4 w-4" />
      Chat
    </Button>
  );
}
