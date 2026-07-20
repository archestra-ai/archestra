import { type ChatMessage, ChatMessageMetadataSchema } from "@archestra/shared";

/**
 * The open-app reference a chat turn carries: the app the client reports as
 * currently open, read off the turn's last user message and normalized to the
 * shape `resolveOpenedApp` takes. Returns undefined when no app is open (or the
 * metadata is absent/malformed), so the turn simply carries no app context.
 *
 * The reference is an untrusted client hint — `resolveOpenedApp` re-runs the
 * caller's access check before injecting anything, so a forged id can only ever
 * surface an app the caller could already see.
 */
export function readOpenedAppRef(
  messages: ChatMessage[],
): { appId: string | null; appMcpServerId: string | null } | undefined {
  const lastUser = messages.findLast((message) => message.role === "user");
  const openedApp = ChatMessageMetadataSchema.safeParse(lastUser?.metadata).data
    ?.openedApp;
  if (!openedApp) return undefined;
  return {
    appId: "appId" in openedApp ? openedApp.appId : null,
    appMcpServerId:
      "appMcpServerId" in openedApp ? openedApp.appMcpServerId : null,
  };
}
