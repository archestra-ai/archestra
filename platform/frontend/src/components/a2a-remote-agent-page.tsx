"use client";

import { CircleCheck, Loader2, PackageX, Power, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  A2aRemoteAgentForm,
  type A2aRemoteAgentFormSubmission,
} from "@/components/a2a-remote-agent-form";
import { AgentIcon } from "@/components/agent-icon";
import { AgentPageShell } from "@/components/agent-pages/agent-page-shell";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { PageBackLink } from "@/components/page-back-link";
import { PageWizard } from "@/components/page-wizard";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { QueryLoadError } from "@/components/query-load-error";
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
  useUpdateA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

const CREATE_BACK_HREF = "/agents/new";
const LIST_HREF = "/agents";
const A2A_SETUP_STEPS = [{ id: "connection", title: "Connection" }] as const;

export function CreateA2aRemoteAgentPage() {
  const router = useRouter();
  const permission = useHasPermissions({ agentSettings: ["update"] });
  const readPermission = useHasPermissions({ agent: ["read"] });
  const createMutation = useCreateA2aRemoteAgent();
  const [formDirty, setFormDirty] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const navigationGuard = usePageUnsavedChangesGuard(formDirty);
  const isReadPermissionKnown = !readPermission.isPending;
  const showsUnreadableSuccess =
    !!created && isReadPermissionKnown && !readPermission.data;

  useEffect(() => {
    if (!created || !isReadPermissionKnown || !readPermission.data) return;
    router.push(a2aRemoteAgentDetailHref(created.id));
  }, [created, isReadPermissionKnown, readPermission.data, router]);

  return (
    <>
      <PageWizard
        title="Connect external A2A agent"
        description="Connect an Agent2Agent-compatible system and choose who can assign it."
        backLink={
          showsUnreadableSuccess ? undefined : (
            <PageBackLink
              href={CREATE_BACK_HREF}
              onNavigate={() => {
                if (createMutation.isPending || created) return;
                navigationGuard.requestNavigate(CREATE_BACK_HREF);
              }}
            >
              Add Agent
            </PageBackLink>
          )
        }
        steps={A2A_SETUP_STEPS}
        activeStep="connection"
      >
        {showsUnreadableSuccess ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleCheck />
              </EmptyMedia>
              <EmptyTitle>External A2A agent connected</EmptyTitle>
              <EmptyDescription>
                <span>
                  &quot;{created.name}&quot; was connected. You do not have
                  permission to view it.
                </span>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : created ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Loader2 className="animate-spin" />
              </EmptyMedia>
              <EmptyTitle>External A2A agent connected</EmptyTitle>
              <EmptyDescription>
                Opening &quot;{created.name}&quot;…
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : permission.isPending ? (
          <FormSkeleton />
        ) : permission.data ? (
          <A2aRemoteAgentForm
            isSaving={createMutation.isPending}
            onDirtyChange={setFormDirty}
            onSubmit={(submission) => {
              if (!submission.source || !submission.scope) return;
              createMutation.mutate(
                {
                  ...submission,
                  source: submission.source,
                  scope: submission.scope,
                  teams: submission.teams ?? [],
                  users: submission.users ?? [],
                },
                {
                  onSuccess: (agent) => {
                    if (!agent) return;
                    setCreated({ id: agent.id, name: agent.name });
                    // The draft is saved and the destination is deliberate;
                    // clear the old capture before routing so it cannot ask
                    // about changes that no longer exist.
                    setFormDirty(false);
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
                permissions={[{ resource: "agentSettings", action: "update" }]}
              />
            </CardContent>
          </Card>
        )}
      </PageWizard>
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
  const permission = useHasPermissions({ agentSettings: ["update"] });
  const updateMutation = useUpdateA2aRemoteAgent(id);
  const deleteMutation = useDeleteA2aRemoteAgent();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const navigationGuard = usePageUnsavedChangesGuard(formDirty);
  const agent = query.data;
  const ownership = useResourceOwnershipTransfer({
    kind: "remoteAgent",
    resource: agent,
    disabledReason: formDirty
      ? "Save or discard your changes first"
      : undefined,
    onTransferred: () => router.push("/agents"),
  });
  const canManage = !!permission.data;

  if (query.isPending || permission.isPending) {
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
        stickyFooter
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
          description: agent.description || "External A2A agent",
          action: canManage ? (
            <div className="flex items-center gap-2">
              <TableRowActions
                dropdownContent={ownership.menuItem}
                itemName={agent.name}
                actions={[]}
                dropdownActions={[
                  {
                    icon: <Power className="h-4 w-4" />,
                    label: agent.connection.enabled
                      ? "Disable delegation"
                      : "Enable delegation",
                    tooltip: agent.connection.enabled
                      ? "Pause this connection everywhere without removing its agent assignments."
                      : "Make this connection available to its assigned agents again.",
                    disabled: updateMutation.isPending || formDirty,
                    disabledTooltip: formDirty
                      ? "Save or discard your changes before changing delegation availability."
                      : undefined,
                    onClick: () =>
                      updateMutation.mutate({
                        enabled: !agent.connection.enabled,
                      }),
                  },
                  {
                    icon: <Trash2 className="h-4 w-4" />,
                    label: "Delete",
                    variant: "destructive",
                    disabled: deleteMutation.isPending || formDirty,
                    disabledTooltip: formDirty
                      ? "Save or discard your changes before deleting this external agent."
                      : undefined,
                    onClick: () => setDeleteOpen(true),
                  },
                ]}
              />
              {ownership.dialog}
            </div>
          ) : undefined,
        }}
      >
        <A2aRemoteAgentForm
          key={`${agent.id}:${agent.updatedAt}`}
          agent={agent}
          readOnly={!canManage}
          isSaving={updateMutation.isPending}
          onDirtyChange={setFormDirty}
          onSubmit={(submission: A2aRemoteAgentFormSubmission) => {
            updateMutation.mutate(submission);
          }}
        />
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
      {["Connection", "Details", "Access"].map((title) => (
        <SettingsSection key={title} title={title}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </SettingsSection>
      ))}
    </SettingsSectionGroup>
  );
}
