"use client";

import {
  DocsPage,
  getDocsUrl,
  type Permissions,
  SecretsManagerType,
} from "@archestra/shared";
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
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDisconnectDialog } from "@/components/runtime-credential-disconnect-dialog";
import { RuntimeCredentialRowContent } from "@/components/runtime-credential-row-content";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { SettingsBlock } from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { useFeature } from "@/lib/config/config.query";
import {
  type RuntimeCredentialDefinition,
  useDeleteRuntimeCredential,
  useDeleteRuntimeCredentialConnection,
  useRuntimeCredentials,
  useRuntimeCredentialUsage,
} from "@/lib/runtime-credentials.query";

import { useSecretsType } from "@/lib/secrets.query";

const MANAGE_CREDENTIALS_PERMISSION: Permissions = {
  credential: ["update"],
};

export function RuntimeCredentialsSection() {
  const definitions = useRuntimeCredentials();
  const { data: secretsType } = useSecretsType();
  const byosEnabled = useFeature("byosEnabled");
  const [definitionDialog, setDefinitionDialog] = useState<
    RuntimeCredentialDefinition | "new" | null
  >(null);
  const [connecting, setConnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const [disconnecting, setDisconnecting] =
    useState<RuntimeCredentialDefinition | null>(null);
  const [deleting, setDeleting] = useState<RuntimeCredentialDefinition | null>(
    null,
  );
  const deleteDefinition = useDeleteRuntimeCredential();
  const disconnect = useDeleteRuntimeCredentialConnection();

  return (
    <>
      <SettingsBlock
        id="credentials"
        title="Saved credentials"
        description={
          <>
            Connect a value once and select it wherever it is needed. Personal
            values belong to each user; organization values are shared.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformCredentials)}
              className="whitespace-nowrap"
            >
              Learn more
            </ExternalDocsLink>
          </>
        }
        control={
          <WithPermissions
            permissions={{ credential: ["create"] }}
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
        {secretsType && (
          <p className="mb-3 text-xs text-muted-foreground">
            {secretsType.type === SecretsManagerType.BYOS_VAULT
              ? "Values reference your external Vault."
              : secretsType.type === SecretsManagerType.Vault
                ? "Values are stored in Vault."
                : "Values are encrypted in the database."}
          </p>
        )}
        {definitions.isError ? (
          <QueryLoadError
            title="Couldn't load credentials"
            onRetry={() => definitions.refetch()}
          />
        ) : (
          <div className="divide-y overflow-hidden rounded-lg border">
            {definitions.isPending ? (
              <p className="p-4 text-sm text-muted-foreground">
                Loading credentials…
              </p>
            ) : definitions.data?.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                Add a credential to make it available to agents, MCP servers,
                skills, and knowledge.
              </p>
            ) : null}
            {(definitions.data ?? []).map((definition) => (
              <div
                key={definition.key}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center"
              >
                <RuntimeCredentialRowContent
                  definition={definition}
                  configured={
                    definition.allowOrganization
                      ? definition.organizationConfigured
                      : definition.personalConfigured
                  }
                  meta={
                    <span>
                      {definition.kind === "github_app"
                        ? "GitHub App"
                        : definition.kind === "github_app_user"
                          ? "GitHub user connection"
                          : "Custom secret"}{" "}
                      ·{" "}
                      {definition.allowOrganization
                        ? "Organization"
                        : "Personal"}
                    </span>
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
          </div>
        )}
      </SettingsBlock>

      {definitionDialog && (
        <RuntimeCredentialDefinitionDialog
          definition={definitionDialog === "new" ? null : definitionDialog}
          onClose={() => setDefinitionDialog(null)}
        />
      )}
      {connecting && (
        <RuntimeCredentialConnectionDialog
          definition={connecting}
          scope={connecting.allowOrganization ? "organization" : "personal"}
          useExternalSecretsManager={byosEnabled}
          onClose={() => setConnecting(null)}
        />
      )}
      <RuntimeCredentialDisconnectDialog
        definition={disconnecting}
        scope={disconnecting?.allowOrganization ? "organization" : "personal"}
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
              scope: disconnecting.allowOrganization
                ? "organization"
                : "personal",
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
  definition: RuntimeCredentialDefinition;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const connected = definition.allowOrganization
    ? definition.organizationConfigured
    : definition.personalConfigured;
  const primaryActions = [
    {
      icon: connected ? (
        <RefreshCw className="size-4" />
      ) : (
        <Plug className="size-4" />
      ),
      label: connected ? "Replace" : "Connect",
      onClick: onConnect,
      permissions: definition.allowOrganization
        ? MANAGE_CREDENTIALS_PERMISSION
        : ({ credential: ["read"] } as Permissions),
    },
  ];
  const dropdownActions = [
    ...(connected
      ? [
          {
            icon: <Unplug className="size-4" />,
            label: "Disconnect",
            onClick: onDisconnect,
            permissions: definition.allowOrganization
              ? MANAGE_CREDENTIALS_PERMISSION
              : ({ credential: ["read"] } as Permissions),
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
            permissions: { credential: ["delete"] } as Permissions,
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
  definition: RuntimeCredentialDefinition | null;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const usage = useRuntimeCredentialUsage(
    definition?.key ?? null,
    definition !== null,
  );
  const agents = [
    ...(usage.data?.agents ?? []),
    ...(usage.data?.resources ?? []),
  ];
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
            <p>Could not check credential usage. Try again before deleting.</p>
          ) : hasBlockingAgents ? (
            <>
              <p>Remove this credential from these resources first:</p>
              <div className="rounded-md border bg-muted/30 p-2">
                {agents.map((agent) => (
                  <Link
                    key={agent.id}
                    href={
                      "kind" in agent
                        ? agent.kind === "mcp"
                          ? "/mcp/registry"
                          : agent.kind === "knowledge"
                            ? "/knowledge/knowledge-bases"
                            : agent.kind === "skill"
                              ? "/skills"
                              : "/plugins"
                        : `/agents/${agent.id}`
                    }
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
