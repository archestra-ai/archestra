"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useOpenAppInChat, useOpenExternalAppInChat } from "@/lib/app.query";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

/**
 * Opens an app in a new chat. The backend seeds a conversation with the app
 * already rendered and returns its id, so this navigates straight to it. An
 * external app whose tool needs inputs comes back with an opening prompt
 * instead, which rides the pending-chat handoff so `/chat/<id>` sends it as
 * the first message.
 *
 * `openingKey` names the app being opened. It stays set through the redirect
 * (the list unmounts on success); only a failure resets it.
 */
export function useOpenApp() {
  const router = useRouter();
  const openOwnedApp = useOpenAppInChat();
  const openExternalApp = useOpenExternalAppInChat();
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const open = async (app: AppListItem, { encryptedChat = false } = {}) => {
    if (openingKey) return;
    setOpeningKey(getAppRowKey(app));
    let conversationId: string | undefined;
    if (app.source === "owned") {
      const result = await openOwnedApp.mutateAsync({
        appId: app.id,
        encryptedChat,
      });
      conversationId = result?.conversationId;
    } else {
      const result = await openExternalApp.mutateAsync({
        mcpServerId: app.mcpServerId,
        resourceUri: app.resourceUri,
        encryptedChat,
      });
      conversationId = result?.conversationId;
      if (conversationId && result?.mode === "prompt" && result.prompt) {
        setPendingProjectChatHandoff({ conversationId, prompt: result.prompt });
      }
    }
    if (!conversationId) {
      setOpeningKey(null);
      return;
    }
    router.push(`/chat/${conversationId}`);
  };

  return { open, openingKey };
}

// Several tools of one server can share a widget resource, so the tool-scoped
// name disambiguates external rows.
export function getAppRowKey(app: AppListItem): string {
  return app.source === "owned"
    ? app.id
    : `${app.mcpServerId}:${app.resourceUri}:${app.name}`;
}
