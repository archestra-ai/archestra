"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound, Lock } from "lucide-react";
import Link from "next/link";
import { useCredentialsPageHref } from "@/components/settings-link";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useMcpCatalogCredentialPreflight } from "@/lib/mcp/internal-mcp-catalog.query";

type McpCredentialBlocker =
  archestraApiTypes.GetInternalMcpCatalogCredentialPreflightResponses["200"]["blockers"][number];

/**
 * Why the install dialog cannot install yet: one notice per saved credential
 * the server needs and the person cannot supply, saying plainly what to do.
 */
export function McpCredentialBlockers({
  blockers,
}: {
  blockers: McpCredentialBlocker[];
}) {
  if (blockers.length === 0) return null;
  return (
    <div className="space-y-2">
      {blockers.map((blocker) => (
        <BlockerNotice key={blocker.envKey} blocker={blocker} />
      ))}
    </div>
  );
}

/**
 * The saved credentials that stop the caller installing this catalog item for
 * themselves. Only items that bind a credential are asked about, so a registry
 * page does not fan out one request per row.
 */
export function useMcpInstallBlockers(item: {
  id: string;
  localConfig?: {
    environment?: { credentialId?: string | null }[] | null;
  } | null;
  /** Registry list rows carry the answer instead of the configuration. */
  bindsCredential?: boolean;
}): McpCredentialBlocker[] {
  const bindsCredential =
    item.bindsCredential ??
    !!item.localConfig?.environment?.some((env) => env.credentialId);
  const { data } = useMcpCatalogCredentialPreflight({
    catalogId: item.id,
    scope: "personal",
    enabled: bindsCredential,
  });
  // A personal-only credential is cured by installing for yourself, which is
  // exactly what this button does.
  return (data ?? []).filter((blocker) => blocker.reason !== "personal_only");
}

/** One sentence for screen readers: the tooltip's content as plain text. */
export function installBlockedSummary(blockers: McpCredentialBlocker[]) {
  return `Can't install yet. ${blockers
    .map((blocker) => `${blocker.credentialName}: ${blockerNextStep(blocker)}`)
    .join(" ")}`;
}

/** Why the Install action is disabled, for its hover tooltip. */
export function InstallBlockedTooltip({
  blockers,
}: {
  blockers: McpCredentialBlocker[];
}) {
  return (
    <div className="max-w-50 py-1 text-left">
      <div className="flex items-center gap-1.5 font-medium">
        <Lock className="size-3.5 text-muted-foreground" />
        Can't install yet
      </div>
      <ul className="mt-1.5 space-y-1">
        {blockers.map((blocker) => (
          <li key={blocker.envKey} className="text-muted-foreground">
            <span className="font-medium text-foreground">
              {blocker.credentialName}
            </span>{" "}
            — {blockerProblem(blocker)} {blockerNextStep(blocker)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function blockerProblem(blocker: McpCredentialBlocker) {
  switch (blocker.reason) {
    case "no_access":
      return "you don't have access.";
    case "not_connected":
      return "you haven't added yours.";
    default:
      return "not set up yet.";
  }
}

function blockerNextStep(blocker: McpCredentialBlocker) {
  switch (blocker.reason) {
    case "no_access":
      return "Ask an admin to share it with you.";
    case "not_connected":
      // Settings → Credentials or Personal Settings, depending on the reader.
      return "Add it in Credentials.";
    default:
      return "Ask an admin to set it up.";
  }
}

function BlockerNotice({ blocker }: { blocker: McpCredentialBlocker }) {
  const credentialsHref = useCredentialsPageHref();
  const name = blocker.credentialName;
  switch (blocker.reason) {
    case "no_access":
      return (
        <InlineNotice>
          <Lock />
          <span className="font-medium">You don't have access to {name}</span>
          <InlineNoticeText>
            This server needs it. Ask an admin to share it with you.
          </InlineNoticeText>
        </InlineNotice>
      );
    case "not_connected":
      return (
        <InlineNotice>
          <KeyRound />
          <span className="font-medium">Add your {name} first</span>
          <InlineNoticeText>
            This server runs with your own value.
          </InlineNoticeText>
          <Button
            asChild
            size="xs"
            variant="outline"
            className="ml-auto shrink-0 bg-background"
          >
            <Link href={credentialsHref}>Open Credentials</Link>
          </Button>
        </InlineNotice>
      );
    case "not_set_up":
      return (
        <InlineNotice>
          <KeyRound />
          <span className="font-medium">{name} isn't set up yet</span>
          <InlineNoticeText>
            This server needs its organization value. Ask an admin to set it up.
          </InlineNoticeText>
        </InlineNotice>
      );
    case "personal_only":
      return (
        <InlineNotice>
          <KeyRound />
          <span className="font-medium">Install this one for yourself</span>
          <InlineNoticeText>
            It runs with each person's own {name}.
          </InlineNoticeText>
        </InlineNotice>
      );
  }
}
