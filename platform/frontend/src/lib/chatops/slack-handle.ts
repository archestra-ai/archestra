/**
 * The default name for an agent's Slack app, which is also the handle people
 * type after @: "Archestra" + "Marketing Team" → "archestra_marketing_team".
 */
export function slackHandleFor(appName: string, agentName: string): string {
  return [appName, agentName]
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 35);
}
