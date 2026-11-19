import type { PanelApp } from "@/components/chat/apps-context";
import type { OpenAppTarget } from "@/lib/hooks/use-open-app";

/**
 * The app to reopen as a new encrypted chat, or null when this chat cannot be
 * swapped for one.
 *
 * A chat's encryption is fixed when the chat is created, and opening an app
 * creates the chat before the user sees a composer. So an app chat that is not
 * encrypted and has no user message yet is still only the app's opening
 * render: reopening the same app encrypted loses nothing. Once the user has
 * written, the chat holds their words and stays as it is.
 */
export function appToReopenAsEncryptedChat(params: {
  conversation:
    | { origin?: string | null; encryptedChat?: boolean | null }
    | null
    | undefined;
  messages: readonly { role: string }[];
  apps: readonly PanelApp[];
}): OpenAppTarget | null {
  const { conversation, messages, apps } = params;
  if (conversation?.origin !== "app_open") return null;
  if (conversation.encryptedChat === true) return null;
  if (messages.some((message) => message.role === "user")) return null;

  const [seeded] = apps;
  if (!seeded) return null;
  if (seeded.appId) return { source: "owned", id: seeded.appId };
  if (seeded.mcpServerId) {
    return {
      source: "external",
      mcpServerId: seeded.mcpServerId,
      resourceUri: seeded.uiResourceUri,
      name: seeded.label,
    };
  }
  return null;
}
