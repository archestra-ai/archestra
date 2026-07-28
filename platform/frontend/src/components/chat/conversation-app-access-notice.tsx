"use client";

import { archestraApiSdk } from "@archestra/shared";
import { useQueries } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { throwOnApiError } from "@/lib/utils";

const { getApp } = archestraApiSdk;

/**
 * Warns that the conversation being shared renders apps its recipients will not
 * be able to open.
 *
 * Chat sharing and app access are separate grants: a shared conversation carries
 * only the app's id, and every viewer re-resolves it against the app's own
 * visibility. Sharing a chat therefore never shares the apps inside it — and
 * apps created from chat are personal by default, so the most natural flow
 * (build an app in a chat, then share that chat) is exactly the one that breaks.
 * Without this the sharer finds out only when the recipient reports a dead tile.
 *
 * Deliberately a warning rather than a "share these too" button: apps have no
 * per-user grant, so the only one-click fix available would widen the app to a
 * whole team or organization — much further than the chat share the user is
 * making. Naming the apps and pointing at their settings keeps that decision
 * explicit.
 */
export function ConversationAppAccessNotice({
  appIds,
  visibility,
  teamIds,
}: {
  /** Owned apps rendered in this conversation. */
  appIds: string[];
  /** Visibility about to be saved. */
  visibility: "private" | "organization" | "team" | "user";
  /** Teams selected for a team share; ignored for other visibilities. */
  teamIds: string[];
}) {
  // Same `["apps", id]` key the chat already populates, so this reads the cache
  // rather than issuing fresh requests. An app the sharer cannot read resolves
  // to null and is skipped — better silent than a warning we cannot substantiate.
  const queries = useQueries({
    queries: appIds.map((appId) => ({
      queryKey: ["apps", appId],
      queryFn: async () => {
        const { data, error } = await getApp({ path: { appId } });
        throwOnApiError(error, { allowNotFound: true, toastOnError: false });
        return data ?? null;
      },
    })),
  });

  // Small lists (a conversation holds a handful of apps at most), so this runs
  // inline rather than behind a memo whose deps would be a fresh array anyway.
  const blockedNames: string[] = [];
  for (const query of queries) {
    const app = query.data;
    if (!app) continue;
    if (isReachableByRecipients({ app, visibility, teamIds })) continue;
    if (!blockedNames.includes(app.name)) blockedNames.push(app.name);
  }

  if (visibility === "private" || blockedNames.length === 0) {
    return null;
  }

  const plural = blockedNames.length > 1;
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>
        {plural ? "Some apps in this chat" : "An app in this chat"} won&apos;t
        open for everyone
      </AlertTitle>
      <AlertDescription>
        <p>
          Sharing a chat doesn&apos;t share the apps inside it.{" "}
          <span className="font-medium">{blockedNames.join(", ")}</span>{" "}
          {plural ? "are" : "is"} not available to everyone you&apos;re sharing
          with, so they&apos;ll see an access message where the{" "}
          {plural ? "apps" : "app"} should be.
        </p>
        <p>
          To change that, open the {plural ? "apps" : "app"} and adjust who can
          use {plural ? "them" : "it"} in App settings.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** Whether every recipient of this share can already open the app. */
function isReachableByRecipients({
  app,
  visibility,
  teamIds,
}: {
  app: { scope: string; enabled: boolean; teams: Array<{ id: string }> };
  visibility: "private" | "organization" | "team" | "user";
  teamIds: string[];
}): boolean {
  // A disabled app is author-only whatever its scope, so no recipient can open it.
  if (!app.enabled) return false;
  if (app.scope === "org") return true;
  // Personal apps are reachable by their author alone — never by a recipient.
  if (app.scope !== "team") return false;
  // A team app is safe only when the share cannot reach past the teams that
  // hold it, which is true only for a team share into those same teams.
  if (visibility !== "team" || teamIds.length === 0) return false;
  const appTeamIds = new Set(app.teams.map((team) => team.id));
  return teamIds.every((teamId) => appTeamIds.has(teamId));
}
