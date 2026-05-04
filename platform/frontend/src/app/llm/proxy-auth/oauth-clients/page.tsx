"use client";

import { type archestraApiTypes, providerDisplayNames } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import {
  type ModelRouterProviderApiKeyMap,
  ModelRouterProviderKeyMappingsField,
  modelRouterProviderApiKeyArrayToMap,
  modelRouterProviderApiKeyMapToArray,
} from "@/components/model-router-provider-key-mappings-field";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useProfiles } from "@/lib/agent.query";
import {
  useCreateLlmOauthClient,
  useDeleteLlmOauthClient,
  useLlmOauthClients,
  useRotateLlmOauthClientSecret,
  useUpdateLlmOauthClient,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import { useSetProxyAuthAction } from "../layout";

type LlmOauthClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"][number];

export default function OAuthClientsPage() {
  const { data: oauthClients = [], isPending } = useLlmOauthClients();
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const createMutation = useCreateLlmOauthClient();
  const updateMutation = useUpdateLlmOauthClient();
  const rotateMutation = useRotateLlmOauthClientSecret();
  const deleteMutation = useDeleteLlmOauthClient();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);
  const [deletingOAuthClient, setDeletingOAuthClient] =
    useState<LlmOauthClient | null>(null);
  const [editingOAuthClient, setEditingOAuthClient] =
    useState<LlmOauthClient | null>(null);
  const [rotatedCredentials, setRotatedCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);

  const setProxyAuthAction = useSetProxyAuthAction();
  useEffect(() => {
    setProxyAuthAction(
      <Button onClick={() => setIsCreateDialogOpen(true)}>
        <Plus className="h-4 w-4" />
        Create OAuth Client
      </Button>,
    );
    return () => setProxyAuthAction(null);
  }, [setProxyAuthAction]);

  const columns: ColumnDef<LlmOauthClient>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="font-medium">{row.original.name}</div>
        ),
      },
      {
        accessorKey: "clientId",
        header: "Client ID",
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.clientId}
          </code>
        ),
      },
      {
        id: "proxies",
        header: "LLM Proxies",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.allowedLlmProxyIds.length}
          </span>
        ),
      },
      {
        id: "providers",
        header: "Providers",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {[
              ...new Set(
                row.original.modelRouterProviderApiKeys.map(
                  (mapping) =>
                    providerDisplayNames[
                      mapping.provider as keyof typeof providerDisplayNames
                    ] ?? mapping.provider,
                ),
              ),
            ].join(", ")}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatRelativeTime(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                onClick: () => setEditingOAuthClient(row.original),
              },
              {
                icon: <RefreshCw className="h-4 w-4" />,
                label: "Rotate secret",
                onClick: async () => {
                  const result = await rotateMutation.mutateAsync({
                    id: row.original.id,
                  });
                  if (result) {
                    setRotatedCredentials({
                      clientId: result.clientId,
                      clientSecret: result.clientSecret,
                    });
                  }
                },
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
                onClick: () => setDeletingOAuthClient(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [rotateMutation],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={oauthClients}
        isLoading={isPending}
        emptyMessage="No OAuth clients registered. Create one for backend services or bots that call the Model Router."
      />

      <CreateOAuthClientDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        llmProxies={llmProxies}
        providerApiKeys={providerApiKeys}
        onSubmit={async (values) => {
          const result = await createMutation.mutateAsync(values);
          if (result) {
            setCreatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
            });
            setIsCreateDialogOpen(false);
          }
        }}
        isSubmitting={createMutation.isPending}
      />

      <EditOAuthClientDialog
        oauthClient={editingOAuthClient}
        onOpenChange={(open) => {
          if (!open) setEditingOAuthClient(null);
        }}
        llmProxies={llmProxies}
        providerApiKeys={providerApiKeys}
        onSubmit={async (id, values) => {
          const result = await updateMutation.mutateAsync({
            id,
            body: values,
          });
          if (result) {
            setEditingOAuthClient(null);
          }
        }}
        isSubmitting={updateMutation.isPending}
      />

      <CredentialsDialog
        open={!!createdCredentials}
        onOpenChange={(open) => {
          if (!open) setCreatedCredentials(null);
        }}
        title="OAuth Client Created"
        credentials={createdCredentials}
      />

      <CredentialsDialog
        open={!!rotatedCredentials}
        onOpenChange={(open) => {
          if (!open) setRotatedCredentials(null);
        }}
        title="Secret Rotated"
        credentials={rotatedCredentials}
      />

      <DeleteConfirmDialog
        open={!!deletingOAuthClient}
        onOpenChange={(open) => {
          if (!open) setDeletingOAuthClient(null);
        }}
        title="Delete OAuth client"
        description={
          deletingOAuthClient
            ? `Delete ${deletingOAuthClient.name}? Existing access tokens will stop working when they expire, and new tokens cannot be issued.`
            : ""
        }
        onConfirm={async () => {
          if (!deletingOAuthClient) return;
          await deleteMutation.mutateAsync({ id: deletingOAuthClient.id });
          setDeletingOAuthClient(null);
        }}
        isPending={deleteMutation.isPending}
      />
    </>
  );
}

function CreateOAuthClientDialog({
  open,
  onOpenChange,
  llmProxies,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  llmProxies: archestraApiTypes.GetAllAgentsResponses["200"];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    values: archestraApiTypes.CreateLlmOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedProxyIds, setSelectedProxyIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ModelRouterProviderApiKeyMap>({});

  const canSubmit =
    name.trim().length > 0 &&
    selectedProxyIds.length > 0 &&
    modelRouterProviderApiKeyMapToArray(providerApiKeyIds).length > 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description="Register a backend service or bot that can call the Model Router with OAuth client credentials."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            name: name.trim(),
            allowedLlmProxyIds: selectedProxyIds,
            modelRouterProviderApiKeys:
              modelRouterProviderApiKeyMapToArray(providerApiKeyIds),
          });
          setName("");
          setSelectedProxyIds([]);
          setProviderApiKeyIds({});
        }}
      >
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="oauth-client-name">Name</Label>
            <Input
              id="oauth-client-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="support-assistant-prod"
            />
          </div>

          <div className="space-y-2">
            <Label>Allowed LLM proxies</Label>
            <MultiSelectCombobox
              options={llmProxies.map((proxy) => ({
                value: proxy.id,
                label: proxy.name,
              }))}
              value={selectedProxyIds}
              onChange={setSelectedProxyIds}
              placeholder="Select LLM proxies"
              emptyMessage="No LLM proxies found"
            />
          </div>

          <ModelRouterProviderKeyMappingsField
            providerApiKeyIds={providerApiKeyIds}
            onProviderApiKeyIdsChange={setProviderApiKeyIds}
            providerApiKeys={providerApiKeys}
          />
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || isSubmitting}>
            Create OAuth Client
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function EditOAuthClientDialog({
  oauthClient,
  onOpenChange,
  llmProxies,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  oauthClient: LlmOauthClient | null;
  onOpenChange: (open: boolean) => void;
  llmProxies: archestraApiTypes.GetAllAgentsResponses["200"];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateLlmOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedProxyIds, setSelectedProxyIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ModelRouterProviderApiKeyMap>({});

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedProxyIds(oauthClient.allowedLlmProxyIds);
    setProviderApiKeyIds(
      modelRouterProviderApiKeyArrayToMap(
        oauthClient.modelRouterProviderApiKeys,
      ),
    );
  }, [oauthClient]);

  const canSubmit =
    !!oauthClient &&
    name.trim().length > 0 &&
    selectedProxyIds.length > 0 &&
    modelRouterProviderApiKeyMapToArray(providerApiKeyIds).length > 0;

  return (
    <FormDialog
      open={!!oauthClient}
      onOpenChange={onOpenChange}
      title="Edit OAuth Client"
      description="Update the LLM proxies and provider keys this OAuth client can use."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          if (!oauthClient) return;
          await onSubmit(oauthClient.id, {
            name: name.trim(),
            allowedLlmProxyIds: selectedProxyIds,
            modelRouterProviderApiKeys:
              modelRouterProviderApiKeyMapToArray(providerApiKeyIds),
          });
        }}
      >
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-oauth-client-name">Name</Label>
            <Input
              id="edit-oauth-client-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="support-assistant-prod"
            />
          </div>

          <div className="space-y-2">
            <Label>Allowed LLM proxies</Label>
            <MultiSelectCombobox
              options={llmProxies.map((proxy) => ({
                value: proxy.id,
                label: proxy.name,
              }))}
              value={selectedProxyIds}
              onChange={setSelectedProxyIds}
              placeholder="Select LLM proxies"
              emptyMessage="No LLM proxies found"
            />
          </div>

          <ModelRouterProviderKeyMappingsField
            providerApiKeyIds={providerApiKeyIds}
            onProviderApiKeyIdsChange={setProviderApiKeyIds}
            providerApiKeys={providerApiKeys}
          />
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || isSubmitting}>
            Save Changes
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function CredentialsDialog({
  open,
  onOpenChange,
  title,
  credentials,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  credentials: { clientId: string; clientSecret: string } | null;
}) {
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Copy the client secret now. It will not be shown again."
    >
      <DialogBody className="space-y-4">
        {credentials && (
          <>
            <div className="space-y-2">
              <Label>Client ID</Label>
              <CopyableCode value={credentials.clientId} />
            </div>
            <div className="space-y-2">
              <Label>Client Secret</Label>
              <CopyableCode value={credentials.clientSecret} />
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <KeyRound className="h-4 w-4" />
                Token endpoint
              </div>
              <CopyableCode value="/api/auth/oauth2/token" />
            </div>
          </>
        )}
      </DialogBody>
      <DialogStickyFooter>
        <Button type="button" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
