// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { ConnectorType } from "@archestra/shared";
import { CONNECTOR_TYPE_LABELS, DocsPage, getDocsUrl } from "@archestra/shared";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { ConnectorUserGroup } from "@/lib/knowledge/connector.query";
import { useConnectorUserGroups } from "@/lib/knowledge/connector.query";

/**
 * Page-level warning for an auto-sync connector with unassigned users: one
 * short paragraph — why they are unassigned, the credential fix, the manual
 * assignment escape hatch on the Users tab, and an inline docs link. Shown
 * on every connector tab so the problem is visible without drilling into
 * the Users table; renders nothing while everyone resolves.
 */
export function ConnectorUnassignedUsersAlert({
  connectorId,
  connectorType,
}: {
  connectorId: string;
  connectorType: ConnectorType;
}) {
  const appName = useAppName();
  const { data: userGroups } = useConnectorUserGroups({
    connectorId,
    enabled: true,
  });
  const { hiddenEmail, noMatchingUser } = countUnassigned(
    userGroups?.groups ?? [],
  );
  const unresolved = hiddenEmail + noMatchingUser;
  if (unresolved === 0) return null;

  const sourceLabel = CONNECTOR_TYPE_LABELS[connectorType] ?? connectorType;

  return (
    // Deliberately the neutral card variant: this is a steady state the admin
    // works through, not an incident. The amber icon is the only accent.
    <Alert className="[&>svg]:text-amber-600">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>
        {unresolved.toLocaleString()} user{unresolved === 1 ? " is" : "s are"}{" "}
        unassigned and can&apos;t access connector&apos;s documents
      </AlertTitle>
      <AlertDescription>
        <p>
          {hiddenEmail > 0 && (
            <>
              {sourceLabel} hides user emails from connector credentials.{" "}
              {hiddenEmailFix(connectorType)} You can also assign {sourceLabel}{" "}
              users to {appName} users manually in the Users tab.{" "}
            </>
          )}
          {noMatchingUser > 0 && (
            <>
              {noMatchingUser.toLocaleString()}{" "}
              {noMatchingUser === 1 ? "has" : "have"} a visible email but no{" "}
              {appName} account — invite them with the same email.{" "}
            </>
          )}
          <a
            href={getDocsUrl(DocsPage.PlatformKnowledge)}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-4"
          >
            Learn more
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}

// ===== Internal pieces =====

/**
 * Unassigned counts over DISTINCT human accounts (the same person appears in
 * many groups; app/bot accounts never resolve and are excluded).
 */
function countUnassigned(groups: ConnectorUserGroup[]): {
  hiddenEmail: number;
  noMatchingUser: number;
} {
  const byAccount = new Map<string, ConnectorUserGroup["members"][number]>();
  for (const group of groups) {
    for (const member of group.members) {
      if (member.accountType === "app") continue;
      byAccount.set(member.accountId, member);
    }
  }
  let hiddenEmail = 0;
  let noMatchingUser = 0;
  for (const member of byAccount.values()) {
    if (member.user) continue;
    if (member.email) noMatchingUser++;
    else hiddenEmail++;
  }
  return { hiddenEmail, noMatchingUser };
}

function hiddenEmailFix(connectorType: ConnectorType): string {
  switch (connectorType) {
    case "jira":
    case "confluence":
      return "Add an Atlassian organization admin API key to the connector credentials to fetch managed accounts' emails.";
    case "github":
      return "Ask users to add a public email to their GitHub profile.";
    default:
      return "User emails resolve automatically once the source makes them visible.";
  }
}
