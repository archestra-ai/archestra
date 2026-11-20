"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { AgentIcon } from "@/components/agent-icon";
import { createdByFact } from "@/components/created-by-cell";
import { formatSpendCap } from "@/components/credential-billing/budget-fields";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { FederatedCredentialsTab } from "@/components/federated-credentials-section";
// SPDX-SnippetEnd
import { OAuthClientApis } from "@/components/oauth-client/apis";
import { OAuthClientIdentityFields } from "@/components/oauth-client/identity-fields";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { OverviewSummary } from "@/components/overview-summary";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceAccessSection } from "@/components/resource-access-section";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import {
  useDeleteOauthClient,
  useOauthClient,
  useRotateOauthClientSecret,
} from "@/lib/oauth-clients.query";
import { useServiceAccount } from "@/lib/service-account.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

const LIST_HREF = "/settings/oauth-clients";

/**
 * An OAuth client: what it reaches and how it signs in, then, for a client
 * that signs in as itself, the federated credentials that let a workload use
 * its own OIDC token instead of the secret. Its configuration is edited on a
 * page of its own, the way a service account's is.
 */
export function OAuthClientDetailPage({
  oauthClientId,
}: {
  oauthClientId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const {
    data: client,
    isPending,
    isLoadingError,
    refetch,
  } = useOauthClient(oauthClientId);
  const { data: canUpdate } = useHasPermissions(
    { oauthClient: ["update"] },
    oauthClientId,
  );
  const { data: canDelete } = useHasPermissions(
    { oauthClient: ["delete"] },
    oauthClientId,
  );
  const rotate = useRotateOauthClientSecret();
  const remove = useDeleteOauthClient();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revealed, setRevealed] = useState<CreatedCredentials | null>(null);
  const [addCredentialOpen, setAddCredentialOpen] = useState(false);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const federationAvailable = useEnterpriseFeature("core");
  // SPDX-SnippetEnd

  // Only a client that signs in as itself has federated credentials.
  const tabs = DETAIL_TABS.filter(
    (tab) =>
      tab.id !== "federated-credentials" ||
      client?.grantType !== "authorization_code",
  );
  const tabParam = searchParams.get("tab");
  const activeTab: DetailTab = tabs.some((tab) => tab.id === tabParam)
    ? (tabParam as DetailTab)
    : "overview";
  const hasFederationTab = tabs.length > 1;

  useEffect(() => {
    setPageHeader({
      title: client ? (
        <span className="block min-w-0 truncate">{client.name}</span>
      ) : (
        "OAuth client"
      ),
      documentTitle: client?.name ?? "OAuth client",
      icon: client ? (
        client.icon ? (
          <AgentIcon icon={client.icon} size={24} />
        ) : client.grantType === "authorization_code" ? (
          <Users />
        ) : (
          <Server />
        )
      ) : undefined,
      backLink: (
        <PageBackLink href={LIST_HREF}>Back to OAuth clients</PageBackLink>
      ),
      tabs: hasFederationTab
        ? DETAIL_TABS.map((tab) => ({
            label: tab.label,
            href: detailTabHref(pathname, tab.id),
            selected: activeTab === tab.id,
          }))
        : undefined,
    });
    return () => setPageHeader(null);
  }, [setPageHeader, client, activeTab, pathname, hasFederationTab]);

  useEffect(() => {
    if (!client) {
      setActionButton(null);
      return;
    }
    const editHref = `${LIST_HREF}/${client.id}/edit`;
    const primary =
      activeTab === "federated-credentials" ? (
        federationAvailable ? (
          <PermissionButton
            permissions={{ oauthClient: ["update"] }}
            permissionScope={client.id}
            size="sm"
            onClick={() => setAddCredentialOpen(true)}
          >
            <Plus className="size-4" />
            <span>Add credential</span>
          </PermissionButton>
        ) : null
      ) : (
        <PermissionButton
          permissions={{ oauthClient: ["update"] }}
          permissionScope={client.id}
          size="sm"
          onClick={() => router.push(editHref)}
        >
          <Pencil className="size-4" />
          <span className="max-sm:sr-only">Edit</span>
        </PermissionButton>
      );
    setActionButton(
      <div className="flex shrink-0 items-center gap-2">
        {primary}
        {(canUpdate || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canUpdate && activeTab !== "overview" && (
                <DropdownMenuItem onClick={() => router.push(editHref)}>
                  <Pencil className="size-4" />
                  Edit OAuth client
                </DropdownMenuItem>
              )}
              {canUpdate && (
                <DropdownMenuItem onClick={() => setRotateOpen(true)}>
                  <RefreshCw className="size-4" />
                  Rotate secret
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="size-4" />
                    Delete OAuth client
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>,
    );
    return () => setActionButton(null);
  }, [
    setActionButton,
    client,
    router,
    canUpdate,
    canDelete,
    activeTab,
    federationAvailable,
  ]);

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this OAuth client"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!client) {
    return (
      <p className="text-sm text-muted-foreground">
        This OAuth client doesn't exist, or was deleted.
      </p>
    );
  }

  return (
    <>
      {activeTab === "overview" && (
        <Overview
          client={client}
          onRotateSecret={canUpdate ? () => setRotateOpen(true) : undefined}
        />
      )}
      {/* SPDX-SnippetBegin
          SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {activeTab === "federated-credentials" && (
        <FederatedCredentialsTab
          owner={{
            kind: "oauthClient",
            id: client.id,
            clientId: client.clientId,
          }}
          canUpdate={!!canUpdate}
          createOpen={addCredentialOpen}
          onCreateOpenChange={setAddCredentialOpen}
        />
      )}
      {/* SPDX-SnippetEnd */}
      <OAuthClientCreatedDialog
        open={!!revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title="Client Secret Rotated"
        credentials={revealed}
      />
      <DeleteConfirmDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title="Rotate Client Secret"
        description={`Rotate the secret for "${client.name}"? The current secret stops working immediately; the new one is shown once.`}
        confirmLabel="Rotate"
        isPending={rotate.isPending}
        onConfirm={async () => {
          const rotated = await rotate.mutateAsync({ id: client.id });
          if (rotated)
            setRevealed({ ...rotated, oauthScope: rotated.scopes.join(" ") });
          setRotateOpen(false);
        }}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete OAuth Client"
        description={`Delete "${client.name}"? Applications using it will stop authenticating. This action cannot be undone.`}
        confirmLabel="Delete"
        isPending={remove.isPending}
        onConfirm={async () => {
          if (await remove.mutateAsync({ id: client.id }))
            router.push(LIST_HREF);
        }}
      />
    </>
  );
}

// === Internal helpers

type Client = archestraApiTypes.GetOauthClientResponses["200"];
type DetailTab = "overview" | "federated-credentials";

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "federated-credentials", label: "Federated Credentials" },
];

/** The overview is the page itself; the other tab is a `?tab=` on it. */
function detailTabHref(pathname: string, tab: DetailTab) {
  return tab === "overview" ? pathname : `${pathname}?tab=${tab}`;
}

function Overview({
  client,
  onRotateSecret,
}: {
  client: Client;
  onRotateSecret?: () => void;
}) {
  const userMode = client.grantType === "authorization_code";
  const SignInIcon = userMode ? Users : Server;
  const reachesTargets = client.scopes.some(
    (scope) => scope === "mcp" || scope === "a2a",
  );
  const llm = client.scopes.includes("llm:proxy");
  const { data: targets = [] } = useAgentOptionsByIds({
    ids: client.allowedGatewayIds.slice(0, 20),
    enabled: reachesTargets && client.allowedGatewayIds.length > 0,
  });
  const { data: account } = useServiceAccount(client.serviceAccountId);

  return (
    <SettingsSectionGroup>
      {/* Only what the client has: an unset service account, no labels or
          no budget say nothing a reader needs, so those facts fall out. */}
      <OverviewSummary
        facts={[
          {
            label: "Signs in",
            value: (
              <span className="flex items-center gap-1.5">
                <SignInIcon className="size-3.5 text-muted-foreground" />
                <span>{userMode ? "For its users" : "As itself"}</span>
              </span>
            ),
          },
          { label: "APIs", value: <OAuthClientApis scopes={client.scopes} /> },
          client.disabled
            ? {
                label: "Status",
                value: <Badge variant="secondary">Disabled</Badge>,
              }
            : null,
          client.serviceAccountId
            ? {
                label: "Service account",
                value: <span>{account?.name ?? "…"}</span>,
              }
            : null,
          reachesTargets && client.allowedGatewayIds.length > 0
            ? {
                label: userMode
                  ? "Additional gateways & agents"
                  : "Gateways & agents",
                value: (
                  <span>
                    {client.allowedGatewayIds
                      .map(
                        (id) =>
                          targets.find((target) => target.id === id)?.name ??
                          "…",
                      )
                      .join(", ")}
                  </span>
                ),
              }
            : null,
          llm
            ? {
                label: "LLM provider keys",
                value: (
                  <span>
                    {userMode
                      ? "Each user's own keys"
                      : client.includeFutureProviders
                        ? "Current and future providers"
                        : client.providerApiKeys
                            .map(
                              (key) => key.providerApiKeyName || key.provider,
                            )
                            .join(", ") || "None"}
                  </span>
                ),
              }
            : null,
          llm && (client.billingTeam || client.spendCap)
            ? {
                label: "Budget",
                value: (
                  <span>
                    {[
                      client.billingTeam?.name,
                      client.spendCap ? formatSpendCap(client.spendCap) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ),
              }
            : null,
          userMode
            ? {
                label: "Redirect URIs",
                value: (
                  <span className="whitespace-pre-line break-all">
                    {client.redirectUris.join("\n")}
                  </span>
                ),
              }
            : null,
          client.labels.length > 0
            ? {
                label: "Labels",
                value: (
                  <span className="flex flex-wrap gap-1">
                    {client.labels.map((label) => (
                      <Badge key={label.key} variant="outline">
                        {label.key}: {label.value}
                      </Badge>
                    ))}
                  </span>
                ),
              }
            : null,
          {
            label: "Created",
            value: (
              <span title={new Date(client.createdAt).toLocaleString()}>
                {formatRelativeTimeFromNow(client.createdAt)}
              </span>
            ),
          },
          createdByFact(client.createdBy),
        ]}
      />
      <SettingsSection
        title="Credentials"
        description={
          userMode
            ? "The application authenticates with its client ID and secret when it trades a user's sign-in for tokens."
            : "The application authenticates with its client ID and secret, or with a workload's OIDC token that one of its federated credentials trusts."
        }
      >
        <OAuthClientIdentityFields
          kindLabel={userMode ? "For its users" : "As itself"}
          clientId={client.clientId}
          onRotateSecret={onRotateSecret}
        />
      </SettingsSection>
      {/* SPDX-SnippetBegin
          SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {/* Saves on its own, so whoever may manage access but not edit the
          client still can. */}
      <SettingsSection
        title="Permissions"
        description="Who can see, edit, or use this OAuth client."
      >
        <ResourceAccessSection
          resource="oauthClient"
          id={client.id}
          standalone
        />
      </SettingsSection>
      {/* SPDX-SnippetEnd */}
    </SettingsSectionGroup>
  );
}
