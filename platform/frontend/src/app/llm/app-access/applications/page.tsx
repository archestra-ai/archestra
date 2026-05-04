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
  useCreateLlmApplication,
  useDeleteLlmApplication,
  useLlmApplications,
  useRotateLlmApplicationSecret,
  useUpdateLlmApplication,
} from "@/lib/llm-applications.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import { useSetAppAccessAction } from "../layout";

type LlmApplication =
  archestraApiTypes.GetLlmApplicationsResponses["200"][number];

export default function ApplicationsPage() {
  const { data: applications = [], isPending } = useLlmApplications();
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const createMutation = useCreateLlmApplication();
  const updateMutation = useUpdateLlmApplication();
  const rotateMutation = useRotateLlmApplicationSecret();
  const deleteMutation = useDeleteLlmApplication();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);
  const [deletingApplication, setDeletingApplication] =
    useState<LlmApplication | null>(null);
  const [editingApplication, setEditingApplication] =
    useState<LlmApplication | null>(null);
  const [rotatedCredentials, setRotatedCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);

  const setAppAccessAction = useSetAppAccessAction();
  useEffect(() => {
    setAppAccessAction(
      <Button onClick={() => setIsCreateDialogOpen(true)}>
        <Plus className="h-4 w-4" />
        Create Application
      </Button>,
    );
    return () => setAppAccessAction(null);
  }, [setAppAccessAction]);

  const columns: ColumnDef<LlmApplication>[] = useMemo(
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
                onClick: () => setEditingApplication(row.original),
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
                onClick: () => setDeletingApplication(row.original),
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
        data={applications}
        isLoading={isPending}
        emptyMessage="No applications registered. Create one for backend services or bots that call the Model Router."
      />

      <CreateApplicationDialog
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

      <EditApplicationDialog
        application={editingApplication}
        onOpenChange={(open) => {
          if (!open) setEditingApplication(null);
        }}
        llmProxies={llmProxies}
        providerApiKeys={providerApiKeys}
        onSubmit={async (id, values) => {
          const result = await updateMutation.mutateAsync({
            id,
            body: values,
          });
          if (result) {
            setEditingApplication(null);
          }
        }}
        isSubmitting={updateMutation.isPending}
      />

      <CredentialsDialog
        open={!!createdCredentials}
        onOpenChange={(open) => {
          if (!open) setCreatedCredentials(null);
        }}
        title="Application Created"
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
        open={!!deletingApplication}
        onOpenChange={(open) => {
          if (!open) setDeletingApplication(null);
        }}
        title="Delete application"
        description={
          deletingApplication
            ? `Delete ${deletingApplication.name}? Existing access tokens will stop working when they expire, and new tokens cannot be issued.`
            : ""
        }
        onConfirm={async () => {
          if (!deletingApplication) return;
          await deleteMutation.mutateAsync({ id: deletingApplication.id });
          setDeletingApplication(null);
        }}
        isPending={deleteMutation.isPending}
      />
    </>
  );
}

function CreateApplicationDialog({
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
    values: archestraApiTypes.CreateLlmApplicationData["body"],
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
      title="Create Application"
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
            <Label htmlFor="application-name">Name</Label>
            <Input
              id="application-name"
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
            Create Application
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function EditApplicationDialog({
  application,
  onOpenChange,
  llmProxies,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  application: LlmApplication | null;
  onOpenChange: (open: boolean) => void;
  llmProxies: archestraApiTypes.GetAllAgentsResponses["200"];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateLlmApplicationData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedProxyIds, setSelectedProxyIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ModelRouterProviderApiKeyMap>({});

  useEffect(() => {
    if (!application) return;
    setName(application.name);
    setSelectedProxyIds(application.allowedLlmProxyIds);
    setProviderApiKeyIds(
      modelRouterProviderApiKeyArrayToMap(
        application.modelRouterProviderApiKeys,
      ),
    );
  }, [application]);

  const canSubmit =
    !!application &&
    name.trim().length > 0 &&
    selectedProxyIds.length > 0 &&
    modelRouterProviderApiKeyMapToArray(providerApiKeyIds).length > 0;

  return (
    <FormDialog
      open={!!application}
      onOpenChange={onOpenChange}
      title="Edit Application"
      description="Update the LLM proxies and provider keys this application can use."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          if (!application) return;
          await onSubmit(application.id, {
            name: name.trim(),
            allowedLlmProxyIds: selectedProxyIds,
            modelRouterProviderApiKeys:
              modelRouterProviderApiKeyMapToArray(providerApiKeyIds),
          });
        }}
      >
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-application-name">Name</Label>
            <Input
              id="edit-application-name"
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
