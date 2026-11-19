"use client";

import {
  CircleAlert,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { AgentIcon } from "@/components/agent-icon";
import { CreatedByCell } from "@/components/created-by-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { OverviewSummary } from "@/components/overview-summary";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { AccountHealthBadge } from "@/components/service-account-status-badge";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import {
  type ServiceAccountDetail,
  useDeleteServiceAccount,
  useServiceAccount,
  useUpdateServiceAccount,
} from "@/lib/service-account.query";
import { getAccountHealth } from "@/lib/service-account-status";
import { useTeam } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { formatRoleName } from "@/lib/utils/role";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { FederatedCredentialsSection } from "./federated-credentials-section";
// SPDX-SnippetEnd
import { ServiceAccountApiKeys } from "./service-account-api-keys";

/**
 * A service account: what it is and who may use it, then one tab per way to
 * sign in as it. Credentials are managed in place, in small dialogs; the
 * account's own fields are edited on a page of their own, the way a role is.
 */
export function ServiceAccountDetailPage({
  serviceAccountId,
}: {
  serviceAccountId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const { data: canRead, isPending: isCheckingPermissions } = useHasPermissions(
    { serviceAccount: ["read"] },
  );
  const { data: canUpdate } = useHasPermissions(
    { serviceAccount: ["update"] },
    serviceAccountId,
  );
  const { data: canDelete } = useHasPermissions(
    { serviceAccount: ["delete"] },
    serviceAccountId,
  );
  const {
    data: account,
    isPending,
    isLoadingError,
    refetch,
  } = useServiceAccount(serviceAccountId);
  const updateMutation = useUpdateServiceAccount();
  const deleteMutation = useDeleteServiceAccount();
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The credential tabs' create dialogs, opened by the header's main button.
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [addCredentialOpen, setAddCredentialOpen] = useState(false);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const federationAvailable = useEnterpriseFeature("core");
  // SPDX-SnippetEnd

  const tabParam = searchParams.get("tab");
  const activeTab: DetailTab = DETAIL_TABS.some((tab) => tab.id === tabParam)
    ? (tabParam as DetailTab)
    : "overview";
  const toggleDisabled = updateMutation.mutate;

  useEffect(() => {
    setPageHeader({
      title: account ? (
        <span className="block min-w-0 truncate">{account.name}</span>
      ) : (
        "Service account"
      ),
      documentTitle: account?.name ?? "Service account",
      icon: account ? <AgentIcon icon={account.icon} size={24} /> : undefined,
      backLink: (
        <PageBackLink href="/settings/service-accounts">
          Back to service accounts
        </PageBackLink>
      ),
      tabs: DETAIL_TABS.map((tab) => ({
        label: tab.label,
        href: detailTabHref(pathname, tab.id),
        // The overview is the absence of `?tab=`, so it is a prefix of every
        // other tab's URL; selection is decided here rather than by matching.
        selected: activeTab === tab.id,
      })),
    });
    return () => setPageHeader(null);
  }, [setPageHeader, account, activeTab, pathname]);

  useEffect(() => {
    if (!account) {
      setActionButton(null);
      return;
    }
    const href = `/settings/service-accounts/${account.id}`;
    // The header's main button is the tab's own main action; on the
    // credential tabs, editing the account moves into the menu.
    const primary =
      activeTab === "api-keys" ? (
        <PermissionButton
          permissions={{ serviceAccount: ["update"] }}
          permissionScope={account.id}
          size="sm"
          onClick={() => setCreateKeyOpen(true)}
        >
          <Plus className="size-4" />
          <span>Create key</span>
        </PermissionButton>
      ) : activeTab === "federated-credentials" ? (
        federationAvailable ? (
          <PermissionButton
            permissions={{ serviceAccount: ["update"] }}
            permissionScope={account.id}
            size="sm"
            onClick={() => setAddCredentialOpen(true)}
          >
            <Plus className="size-4" />
            <span>Add credential</span>
          </PermissionButton>
        ) : null
      ) : (
        <PermissionButton
          permissions={{ serviceAccount: ["update"] }}
          permissionScope={account.id}
          size="sm"
          onClick={() => router.push(`${href}/edit`)}
        >
          <Pencil className="size-4" />
          <span className="max-sm:sr-only">Edit</span>
        </PermissionButton>
      );
    const editInMenu = activeTab !== "overview" && canUpdate;
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
              {editInMenu && (
                <DropdownMenuItem onClick={() => router.push(`${href}/edit`)}>
                  <Pencil className="size-4" />
                  Edit service account
                </DropdownMenuItem>
              )}
              {canUpdate && (
                <DropdownMenuItem
                  onClick={() =>
                    toggleDisabled({
                      id: account.id,
                      body: { disabled: !account.disabled },
                    })
                  }
                >
                  {account.disabled ? (
                    <Power className="size-4" />
                  ) : (
                    <PowerOff className="size-4" />
                  )}
                  {account.disabled
                    ? "Enable service account"
                    : "Disable service account"}
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete service account
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>,
    );
    return () => setActionButton(null);
  }, [
    setActionButton,
    account,
    router,
    canUpdate,
    canDelete,
    toggleDisabled,
    activeTab,
    federationAvailable,
  ]);

  if (!isCheckingPermissions && !canRead) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>
          You do not have permission to view service accounts.
        </AlertDescription>
      </Alert>
    );
  }
  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this service account"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!account) {
    return (
      <p className="text-sm text-muted-foreground">
        This service account doesn't exist, or was deleted.
      </p>
    );
  }

  return (
    <>
      {activeTab === "overview" && <Overview account={account} />}
      {activeTab === "api-keys" && (
        <ServiceAccountApiKeys
          serviceAccount={account}
          canUpdate={!!canUpdate}
          createOpen={createKeyOpen}
          onCreateOpenChange={setCreateKeyOpen}
        />
      )}
      {/* SPDX-SnippetBegin
          SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {activeTab === "federated-credentials" && (
        <FederatedCredentialsTab
          serviceAccountId={account.id}
          canUpdate={!!canUpdate}
          createOpen={addCredentialOpen}
          onCreateOpenChange={setAddCredentialOpen}
        />
      )}
      {/* SPDX-SnippetEnd */}
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete service account"
        description="Deleting a service account immediately invalidates all of its API keys. To stop it reversibly, disable it instead."
        isPending={deleteMutation.isPending}
        onConfirm={() =>
          deleteMutation.mutate(account.id, {
            onSuccess: (deleted) => {
              if (deleted) router.push("/settings/service-accounts");
            },
          })
        }
      />
    </>
  );
}

// === Internal helpers

/** The overview is the page itself; every other tab is a `?tab=` on it. */
function detailTabHref(pathname: string, tab: DetailTab) {
  return tab === "overview" ? pathname : `${pathname}?tab=${tab}`;
}

type DetailTab = "overview" | "api-keys" | "federated-credentials";

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "api-keys", label: "API Keys" },
  { id: "federated-credentials", label: "Federated Credentials" },
];

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/** Federated credentials need an enterprise license; without one, say so. */
function FederatedCredentialsTab({
  serviceAccountId,
  canUpdate,
  createOpen,
  onCreateOpenChange,
}: {
  serviceAccountId: string;
  canUpdate: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const federationAvailable = useEnterpriseFeature("core");
  if (!federationAvailable) {
    return (
      <InlineNotice variant="info">
        <CircleAlert />
        <InlineNoticeText>
          Federated credentials need an enterprise license. They let a CI job
          sign in with its own OIDC token instead of an API key.
        </InlineNoticeText>
      </InlineNotice>
    );
  }
  return (
    <FederatedCredentialsSection
      serviceAccountId={serviceAccountId}
      canUpdate={canUpdate}
      createOpen={createOpen}
      onCreateOpenChange={onCreateOpenChange}
    />
  );
}
// SPDX-SnippetEnd

function Overview({ account }: { account: ServiceAccountDetail }) {
  const roles = account.role
    .split(",")
    .map((role) => formatRoleName(role.trim()));
  const { data: team } = useTeam(account.teamId ?? undefined);

  return (
    <SettingsSectionGroup>
      {/* What the account is for leads; then only what the account has: an
          empty team, no labels or "never used" say nothing a reader needs, so
          those facts fall out. */}
      <OverviewSummary
        description={account.description}
        facts={[
          {
            label: "Status",
            value: <AccountHealthBadge health={getAccountHealth(account)} />,
          },
          {
            label: roles.length === 1 ? "Role" : "Roles",
            value: (
              <span className="flex flex-wrap gap-1">
                {roles.map((role) => (
                  <Badge key={role} variant="secondary">
                    {role}
                  </Badge>
                ))}
              </span>
            ),
          },
          account.teamId
            ? { label: "Team", value: <span>{team?.name ?? "…"}</span> }
            : null,
          account.labels.length > 0
            ? {
                label: "Labels",
                value: (
                  <span className="flex flex-wrap gap-1">
                    {account.labels.map((label) => (
                      <Badge key={label.key} variant="outline">
                        {label.key}: {label.value}
                      </Badge>
                    ))}
                  </span>
                ),
              }
            : null,
          account.lastUsedAt
            ? {
                label: "Last used",
                value: (
                  <span title={new Date(account.lastUsedAt).toLocaleString()}>
                    {formatRelativeTimeFromNow(account.lastUsedAt)}
                  </span>
                ),
              }
            : null,
          {
            label: "Created",
            value: (
              <span className="flex items-center gap-1.5">
                <span title={new Date(account.createdAt).toLocaleString()}>
                  {formatRelativeTimeFromNow(account.createdAt)}
                </span>
                {account.createdBy && (
                  <>
                    <span className="text-muted-foreground">by</span>
                    <CreatedByCell createdBy={account.createdBy} />
                  </>
                )}
              </span>
            ),
          },
        ]}
      />
      {/* SPDX-SnippetBegin
          SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {/* Saves on its own, so whoever may manage access but not edit the
          account still can. */}
      <SettingsSection
        title="Permissions"
        description="Who can see, edit, or use this service account."
      >
        <ResourceAccessSection
          resource="serviceAccount"
          id={account.id}
          standalone
        />
      </SettingsSection>
      {/* SPDX-SnippetEnd */}
    </SettingsSectionGroup>
  );
}
