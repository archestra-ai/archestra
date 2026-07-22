import type { UIMessage } from "@ai-sdk/react";
import { archestraApiSdk } from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
import { throwOnApiError } from "@/lib/utils";
import type { PanelApp } from "./apps-context";
import { deriveAppsFromMessages } from "./chat-messages.utils";

const { getApp } = archestraApiSdk;

// Derives the conversation's apps from its messages and, when `filterDeleted` is
// set, drops owned apps that no longer exist (deleted, or access lost) so they
// don't linger in the panel. Existence is resolved via the shared `["apps", id]`
// query cache, so a delete elsewhere flips this list too; only ids whose fetch
// settled to a 404 count as deleted, so apps still loading stay visible.
export function useChatApps({
  messages,
  earlyToolUiStarts,
  filterDeleted = false,
}: {
  messages: UIMessage[];
  earlyToolUiStarts: Record<
    string,
    { uiResourceUri?: string; toolName?: string }
  >;
  filterDeleted?: boolean;
}): PanelApp[] {
  const { getToolShortName } = useArchestraMcpIdentity();
  const apps = useMemo(
    () => deriveAppsFromMessages(messages, earlyToolUiStarts, getToolShortName),
    [messages, earlyToolUiStarts, getToolShortName],
  );

  const ownedAppIds = filterDeleted
    ? apps.flatMap((a) => (a.appId ? [a.appId] : []))
    : [];
  const appQueries = useQueries({
    queries: ownedAppIds.map((appId) => ({
      queryKey: ["apps", appId],
      queryFn: async () => {
        const { data, error } = await getApp({ path: { appId } });
        throwOnApiError(error, { allowNotFound: true });
        return data ?? null;
      },
    })),
  });
  // Stable key over the deleted ids so the filtered list only changes when the
  // set of deleted apps actually does (useQueries returns a fresh array each render).
  const deletedKey = ownedAppIds
    .filter((_, i) => appQueries[i].isSuccess && appQueries[i].data === null)
    .join(",");

  return useMemo(() => {
    if (!deletedKey) return apps;
    const deleted = new Set(deletedKey.split(","));
    return apps.filter((a) => !a.appId || !deleted.has(a.appId));
  }, [apps, deletedKey]);
}
