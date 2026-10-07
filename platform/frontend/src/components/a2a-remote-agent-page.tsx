"use client";

import { PackageX, Power, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import {
  A2aRemoteAgentForm,
  type A2aRemoteAgentFormSubmission,
} from "@/components/a2a-remote-agent-form";
import { AgentIcon } from "@/components/agent-icon";
import { AgentPageShell } from "@/components/agent-pages/agent-page-shell";
import { CreatedByCell } from "@/components/created-by-cell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourcePermissions } from "@/components/resource-permissions";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { useResourceOwnershipTransfer } from "@/components/use-resource-ownership-transfer";
import { getA2aRemoteAgentDeleteDescription } from "@/lib/a2a-remote-agent-delete";
import { a2aRemoteAgentDetailHref } from "@/lib/a2a-remote-agent-route";
import {
  useA2aRemoteAgent,
  useCreateA2aRemoteAgent,
  useDeleteA2aRemoteAgent,
  useExternalAgentCapabilities,
  useUpdateA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

const CREATE_BACK_HREF = "/agents/new";
const LIST_HREF = "/agents";

export function CreateA2aRemoteAgentPage() {
  const router = useRouter();
  const permission = useHasPermissions({ agent: ["create"] });
  const createMutation = useCreateA2aRemoteAgent();
  const [formDirty, setFormDirty] = useState(false);
  const navigationGuard = usePageUnsavedChangesGuard(formDirty);

  return (
    <>
      <AgentPageShell
        backHref={CREATE_BACK_HREF}
        backLabel="Add Agent"
        onBackRequest={() => navigationGuard.requestNavigate(CREATE_BACK_HREF)}
        header={{
          title: "Connect external A2A agent",
          description:
            "Connect an Agent2Agent-compatible system and choose who can use it.",
        }}
      >
        {permission.isPending ? (
          <FormSkeleton />
        ) : permission.data ? (
          <A2aRemoteAgentForm
            isSaving={createMutation.isPending}
            onDirtyChange={setFormDirty}
            onSubmit={(submission) => {
              if (!submission.source) return;
              createMutation.mutate(
                { ...submission, source: submission.source },
                {
                  onSuccess: (agent) => {
                    if (agent) router.push(a2aRemoteAgentDetailHref(agent.id));
                  },
                },
              );
            }}
          />
        ) : (
          <Card>
            <CardContent className="py-6">
              <PermissionRequirementHint
                message="Connecting external A2A agents requires"
                permissions={[{ resource: "agent", action: "create" }]}
              />
            </CardContent>
          </Card>
        )}
      </AgentPageShell>
      <UnsavedChangesDialog
        open={navigationGuard.confirmOpen}
        onKeepEditing={navigationGuard.keepEditing}
        onDiscard={navigationGuard.discardChanges}
      />
    </>
  );
}

export function A2aRemoteAgentDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const query = useA2aRemoteAgent(id);
  const capabilities = useExternalAgentCapabilities();
  const updateMutation = useUpdateA2aRemoteAgent(id);
  const deleteMutation = useDeleteA2aRemoteAgent();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  // The Permissions section keeps its own edits. The form's Save commits them.
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );
  const hasUnsavedChanges = formDirty || permissionsDirty;
  const navigationGuard = usePageUnsavedChangesGuard(hasUnsavedChanges);
  const agent = query.data;
  const ownership = useResourceOwnershipTransfer({
    kind: "remoteAgent",
    resource: agent,
    disabledReason: hasUnsavedChanges
      ? "Save or discard your changes first"
      : undefined,
    onTransferred: () => router.push("/agents"),
  });
  const canUpdate = capabilities.can(id, "update");
  const canDelete = capabilities.can(id, "delete");
  const canManage = canUpdate || canDelete;

  if (query.isPending || capabilities.isPending) {
    return (
      <DetailShell title="External A2A agent">
        <FormSkeleton />
      </DetailShell>
    );
  }

  if (query.isError) {
    return (
      <DetailShell title="External A2A agent">
        <QueryLoadError
          className="border"
          title="Couldn't load this external A2A agent"
          onRetry={() => query.refetch()}
        />
      </DetailShell>
    );
  }

  if (!agent) {
    return (
      <DetailShell title="External A2A agent">
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageX />
            </EmptyMedia>
            <EmptyTitle>External A2A agent not found</EmptyTitle>
            <EmptyDescription>
              This external agent does not exist or is not visible to you. It
              may have been removed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </DetailShell>
    );
  }

  return (
    <>
      <AgentPageShell
        backHref={LIST_HREF}
        backLabel="Agents"
        onBackRequest={() => navigationGuard.requestNavigate(LIST_HREF)}
        header={{
          documentTitle: agent.name,
          title: (
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                <AgentIcon size={24} />
              </div>
              <span className="min-w-0 truncate">{agent.name}</span>
              <Badge variant="secondary" className="font-normal">
                A2A
              </Badge>
            </div>
          ),
          description: (
            <span className="block truncate md:pr-6">
              {agent.description || "External A2A agent"}
            </span>
          ),
          action:
            canManage || agent.createdBy ? (
              <div className="flex min-w-0 shrink-0 items-center gap-2">
                {agent.createdBy && (
                  <p className="mr-1 hidden min-w-0 max-w-56 items-center gap-1.5 text-xs text-muted-foreground md:flex">
                    <span className="shrink-0">Created by</span>
                    <CreatedByCell
                      createdBy={agent.createdBy}
                      className="flex-1"
                    />
                  </p>
                )}
                {canManage && (
                  <>
                    <TableRowActions
                      dropdownContent={ownership.menuItem}
                      itemName={agent.name}
                      actions={[]}
                      dropdownActions={[
                        ...(canUpdate
                          ? [
                              {
                                icon: <Power className="h-4 w-4" />,
                                label: agent.connection.enabled
                                  ? "Disable delegation"
                                  : "Enable delegation",
                                tooltip: agent.connection.enabled
                                  ? "Pause this connection everywhere without removing its agent assignments."
                                  : "Make this connection available to its assigned agents again.",
                                disabled:
                                  updateMutation.isPending || hasUnsavedChanges,
                                disabledTooltip: hasUnsavedChanges
                                  ? "Save or discard your changes before changing delegation availability."
                                  : undefined,
                                onClick: () =>
                                  updateMutation.mutate({
                                    enabled: !agent.connection.enabled,
                                  }),
                              },
                            ]
                          : []),
                        ...(canDelete
                          ? [
                              {
                                icon: <Trash2 className="h-4 w-4" />,
                                label: "Delete",
                                variant: "destructive" as const,
                                disabled:
                                  deleteMutation.isPending || hasUnsavedChanges,
                                disabledTooltip: hasUnsavedChanges
                                  ? "Save or discard your changes before deleting this external agent."
                                  : undefined,
                                onClick: () => setDeleteOpen(true),
                              },
                            ]
                          : []),
                      ]}
                    />
                    {ownership.dialog}
                  </>
                )}
              </div>
            ) : undefined,
        }}
      >
        <A2aRemoteAgentForm
          key={`${agent.id}:${agent.updatedAt}`}
          agent={agent}
          readOnly={!canUpdate}
          isSaving={updateMutation.isPending}
          onDirtyChange={setFormDirty}
          onSubmit={(submission: A2aRemoteAgentFormSubmission) => {
            updateMutation.mutate(submission);
          }}
          permissions={{
            section: (
              <ResourcePermissions
                layout="settings"
                resource="externalAgent"
                scope={agent.id}
                onDirtyChange={setPermissionsDirty}
                registerSave={registerPermissionsSave}
              />
            ),
            dirty: permissionsDirty,
            save: async () => {
              await permissionsSave.current?.();
            },
          }}
        />
        {!canUpdate && (
          <div className="border-t pt-8">
            <ResourcePermissions
              layout="settings"
              resource="externalAgent"
              scope={agent.id}
              onDirtyChange={setPermissionsDirty}
            />
          </div>
        )}
      </AgentPageShell>
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Remove external A2A agent?"
        description={getA2aRemoteAgentDeleteDescription(agent)}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          deleteMutation.mutate(agent.id, {
            onSuccess: () => router.push(LIST_HREF),
          });
        }}
      />
      <UnsavedChangesDialog
        open={navigationGuard.confirmOpen}
        onKeepEditing={navigationGuard.keepEditing}
        onDiscard={navigationGuard.discardChanges}
      />
    </>
  );
}

function usePageUnsavedChangesGuard(isDirty: boolean) {
  const router = useRouter();
  const pendingHrefRef = useRef<string | null>(null);
  useBeforeUnloadWhileDirty(isDirty);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) router.push(href);
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });
  return { ...guard, requestNavigate };
}

function DetailShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <AgentPageShell backHref={LIST_HREF} backLabel="Agents" header={{ title }}>
      {children}
    </AgentPageShell>
  );
}

function FormSkeleton() {
  return (
    <SettingsSectionGroup>
      {["Connection", "Details", "Permissions"].map((title) => (
        <SettingsSection key={title} title={title}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </SettingsSection>
      ))}
    </SettingsSectionGroup>
  );
}
