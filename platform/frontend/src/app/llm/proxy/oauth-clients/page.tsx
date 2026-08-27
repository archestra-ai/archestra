import { redirect } from "next/navigation";

/**
 * OAuth clients used to be managed here, under the LLM Proxy's tab bar, while
 * the MCP ones were reachable only from a gateway's Connect dialog. They are
 * now one list in settings, so this route only forwards — bookmarks, docs and
 * deep links from before the move still land somewhere real, on the LLM half
 * of that list.
 */
export default function LlmProxyOauthClientsRedirect() {
  redirect("/settings/oauth-clients?type=llm");
}
