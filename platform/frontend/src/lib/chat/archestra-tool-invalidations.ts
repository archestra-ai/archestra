import {
  extractMcpToolError,
  TOOL_PUBLISH_APP_SHORT_NAME,
} from "@archestra/shared";
import { getRenderedToolName } from "@/lib/chat/swap-agent.utils";

/** The slice of a UIMessage tool part this module inspects. */
type ToolResultPart = {
  type?: string;
  toolName?: string;
  state?: string;
  output?: unknown;
  errorText?: string;
};

/**
 * Archestra MCP tools that mutate data server-side, inside the chat loop —
 * bypassing the frontend mutation hooks whose onSuccess normally invalidates
 * the affected caches — mapped to the query keys those hooks would have
 * invalidated. `publish_app` mirrors `useUpdateApp` (app.query.ts): `["apps"]`
 * covers the paginated list and every `["apps", appId]` detail (the scope
 * shown in the settings dialog), `["mcp-catalog"]` because publishing writes
 * the new scope through to the app's backing catalog, which drives the MCP
 * registry card.
 */
const ARCHESTRA_TOOL_INVALIDATIONS = new Map<string, readonly string[][]>([
  [TOOL_PUBLISH_APP_SHORT_NAME, [["apps"], ["mcp-catalog"]]],
]);

/**
 * Query keys to invalidate for the archestra tool results in a finished
 * assistant message. Only delivered, successful results count: the server-side
 * write has provably happened, so the refetch cannot race it (invalidating on
 * the tool *call* instead would let an active observer refetch before the
 * write and re-cache the stale value for another staleTime window), and an
 * errored tool mutated nothing.
 */
export function collectArchestraToolInvalidations(params: {
  parts: unknown[] | undefined;
  getToolShortName: (toolName: string) => string | null;
}): string[][] {
  const collected = new Map<string, string[]>();
  for (const rawPart of params.parts ?? []) {
    if (typeof rawPart !== "object" || rawPart === null) continue;
    const part = rawPart as ToolResultPart;
    const toolName = getRenderedToolName(part);
    if (!toolName) continue;
    const shortName = params.getToolShortName(toolName);
    if (!shortName) continue;
    const queryKeys = ARCHESTRA_TOOL_INVALIDATIONS.get(shortName);
    if (!queryKeys) continue;
    if (part.state !== "output-available") continue;
    if (typeof part.errorText === "string" && part.errorText.length > 0) {
      continue;
    }
    if (extractMcpToolError(part.output) !== null) continue;
    for (const queryKey of queryKeys) {
      collected.set(JSON.stringify(queryKey), [...queryKey]);
    }
  }
  return [...collected.values()];
}
