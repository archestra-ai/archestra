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
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
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
import { getA2aRemoteAgentDeleteDescription } from "@/lib/a2a-remote-agent-delete";
import {
  useA2aRemoteAgent,
  useCreateA2aRemoteAgent,
  useDeleteA2aRemoteAgent,
  useUpdateA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

const LIST_HREF = "/a2a/agents";

export function CreateA2aRemoteAgentPage() {
  const router = useRouter();
  const permission = useHasPermissions({ agentSettings: ["update"] });
  const createMutation = useCreateA2aRemoteAgent();
  const [formDirty, setFormDirty] = useState(false);
  const navigationGuard = usePageUnsavedChangesGuard(formDirty);

  return (
    <>
      <AgentPageShell
        backHref={LIST_HREF}
        backLabel="External Agents"
        onBackRequest={() => navigationGuard.requestNavigate(LIST_HREF)}
        header={{
          title: "Connect external A2A agent",
          description:
            "Connect an Agent2Agent-compatible system and choose who can assign it.",
        }}
      >
        {permission.isPending ? (
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
                    if (agent) router.push(`${LIST_HREF}/${agent.id}`);
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
  const permission = useHasPermissions({ agentSettings: ["update"] });
  const updateMutation = useUpdateA2aRemoteAgent(id);
  const deleteMutation = useDeleteA2aRemoteAgent();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const navigationGuard = usePageUnsavedChangesGuard(formDirty);
  const agent = query.data;
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
        backHref={LIST_HREF}
        backLabel="External Agents"
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
                External Agents
              </Badge>
            </div>
          ),
          description: agent.description || "External A2A agent",
          action: canManage ? (
            <TableRowActions
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
    <AgentPageShell
      backHref={LIST_HREF}
      backLabel="External Agents"
      header={{ title }}
    >
      {children}
    </AgentPageShell>
  );
}

function FormSkeleton() {
  return (
    <SettingsSectionGroup>
      {["Agent Card", "Authentication", "Details", "Access"].map((title) => (
        <SettingsSection key={title} title={title}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </SettingsSection>
      ))}
    </SettingsSectionGroup>
  );
}
