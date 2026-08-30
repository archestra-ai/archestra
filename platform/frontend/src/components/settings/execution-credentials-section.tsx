"use client";

import { DocsPage, getDocsUrl, type Permissions } from "@archestra/shared";
import {
  AlertTriangle,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { ExecutionCredentialDisconnectDialog } from "@/components/execution-credential-disconnect-dialog";
import { ExecutionCredentialRowContent } from "@/components/execution-credential-row-content";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { ExecutionCredentialDefinitionDialog } from "@/components/settings/execution-credential-definition-dialog";
import { SettingsBlock } from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { useFeature } from "@/lib/config/config.query";
import {
  type ExecutionCredentialDefinition,
  useDeleteExecutionCredential,
  useDeleteExecutionCredentialConnection,
  useExecutionCredentials,
  useExecutionCredentialUsage,
} from "@/lib/execution-credentials.query";

const MANAGE_CREDENTIALS_PERMISSION: Permissions = {
  agentSettings: ["update"],
};

export function ExecutionCredentialsSection() {
  const definitions = useExecutionCredentials();
  const byosEnabled = useFeature("byosEnabled");
  const [definitionDialog, setDefinitionDialog] = useState<
    ExecutionCredentialDefinition | "new" | null
  >(null);
  const [connecting, setConnecting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const [disconnecting, setDisconnecting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const [deleting, setDeleting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const deleteDefinition = useDeleteExecutionCredential();
  const disconnect = useDeleteExecutionCredentialConnection();

  return (
    <>
      <SettingsBlock
        id="execution-credentials"
        title="Execution credentials"
        description={
          <>
            Reusable secrets for Background execution. Users connect personal
            values; administrators can connect organization values.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformExecutionCredentials)}
              className="whitespace-nowrap"
            >
              Learn more
            </ExternalDocsLink>
          </>
        }
        control={
          <WithPermissions
            permissions={MANAGE_CREDENTIALS_PERMISSION}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Button
                type="button"
                size="sm"
                disabled={!hasPermission}
                onClick={() => setDefinitionDialog("new")}
              >
                <Plus className="size-4" />
                Add credential
              </Button>
            )}
          </WithPermissions>
        }
      >
        {definitions.isError ? (
          <QueryLoadError
            title="Couldn't load execution credentials"
            onRetry={() => definitions.refetch()}
          />
        ) : (
          <div className="divide-y overflow-hidden rounded-lg border">
            {(definitions.data ?? []).map((definition) => (
              <div
                key={definition.key}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center"
              >
                <ExecutionCredentialRowContent
                  definition={definition}
                  configured={definition.organizationConfigured}
                  meta={
                    definition.allowOrganization
                      ? "Provided once for the organization"
                      : "Provided privately by each user"
                  }
                />
                <CredentialActions
                  definition={definition}
                  onConnect={() => setConnecting(definition)}
                  onDisconnect={() => setDisconnecting(definition)}
                  onEdit={() => setDefinitionDialog(definition)}
                  onDelete={() => setDeleting(definition)}
                />
              </div>
            ))}
            {!definitions.isPending && definitions.data?.length === 0 && (
              <p className="p-5 text-sm text-muted-foreground">
                No execution credentials are available.
              </p>
            )}
          </div>
        )}
      </SettingsBlock>

      {definitionDialog && (
        <ExecutionCredentialDefinitionDialog
          definition={definitionDialog === "new" ? null : definitionDialog}
          onClose={() => setDefinitionDialog(null)}
        />
      )}
      {connecting && (
        <ExecutionCredentialConnectionDialog
          definition={connecting}
          scope="organization"
          useExternalSecretsManager={byosEnabled}
          onClose={() => setConnecting(null)}
        />
      )}
      <ExecutionCredentialDisconnectDialog
        definition={disconnecting}
        scope="organization"
        open={disconnecting !== null}
        isPending={disconnect.isPending}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        onConfirm={() => {
          if (!disconnecting) return;
          disconnect.mutate(
            {
              key: disconnecting.key,
              name: disconnecting.name,
              scope: "organization",
            },
            { onSuccess: () => setDisconnecting(null) },
          );
        }}
      />
      <DeleteCredentialDialog
        definition={deleting}
        isPending={deleteDefinition.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => {
          if (!deleting) return;
          deleteDefinition.mutate(
            { key: deleting.key, name: deleting.name },
            { onSuccess: () => setDeleting(null) },
          );
        }}
      />
    </>
  );
}

function CredentialActions({
  definition,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  definition: ExecutionCredentialDefinition;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const primaryActions = definition.allowOrganization
    ? [
        {
          icon: definition.organizationConfigured ? (
            <RefreshCw className="size-4" />
          ) : (
            <Plug className="size-4" />
          ),
          label: definition.organizationConfigured ? "Replace" : "Connect",
          onClick: onConnect,
          permissions: MANAGE_CREDENTIALS_PERMISSION,
        },
      ]
    : [];
  const dropdownActions = [
    ...(definition.organizationConfigured
      ? [
          {
            icon: <Unplug className="size-4" />,
            label: "Disconnect",
            onClick: onDisconnect,
            permissions: MANAGE_CREDENTIALS_PERMISSION,
            variant: "destructive" as const,
          },
        ]
      : []),
    ...(!definition.builtIn
      ? [
          {
            icon: <Pencil className="size-4" />,
            label: "Edit",
            onClick: onEdit,
            permissions: MANAGE_CREDENTIALS_PERMISSION,
          },
          {
            icon: <Trash2 className="size-4" />,
            label: "Delete",
            onClick: onDelete,
            permissions: MANAGE_CREDENTIALS_PERMISSION,
            variant: "destructive" as const,
          },
        ]
      : []),
  ];

  if (primaryActions.length === 0 && dropdownActions.length === 0) return null;
  return (
    <div className="self-end sm:self-auto">
      <TableRowActions
        actions={primaryActions}
        dropdownActions={dropdownActions}
        itemName={definition.name}
      />
    </div>
  );
}

function DeleteCredentialDialog({
  definition,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  definition: ExecutionCredentialDefinition | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const usage = useExecutionCredentialUsage(
    definition?.key ?? null,
    definition !== null,
  );
  const agents = usage.data?.agents ?? [];
  const hasBlockingAgents = agents.length > 0;
  const confirmDisabled =
    usage.isPending || usage.isError || hasBlockingAgents || isPending;

  return (
    <DeleteConfirmDialog
      open={definition !== null}
      onOpenChange={onOpenChange}
      title="Delete credential?"
      description={
        <div className="space-y-3">
          {usage.isPending ? (
            <p>Checking where this credential is used...</p>
          ) : usage.isError ? (
            <p>Could not check Agent usage. Try again before deleting.</p>
          ) : hasBlockingAgents ? (
            <>
              <p>Remove this credential from these Agents first:</p>
              <div className="rounded-md border bg-muted/30 p-2">
                {agents.map((agent) => (
                  <Link
                    key={agent.id}
                    href={`/agents/${agent.id}`}
                    className="block truncate rounded px-2 py-1 text-sm text-foreground hover:bg-muted"
                  >
                    {agent.name}
                  </Link>
                ))}
              </div>
            </>
          ) : (
            <p>
              {definition?.name ?? "This credential"} and its connected value
              will be permanently deleted.
            </p>
          )}
          {usage.isError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="text-xs leading-5">
                Deletion is disabled until the usage check succeeds.
              </span>
            </div>
          )}
        </div>
      }
      isPending={isPending}
      onConfirm={onConfirm}
      confirmDisabled={confirmDisabled}
    />
  );
}
