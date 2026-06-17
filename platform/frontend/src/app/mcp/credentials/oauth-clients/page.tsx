"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { SearchInput } from "@/components/search-input";
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
import { useProfiles } from "@/lib/agent.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useCreateMcpOauthClient,
  useDeleteMcpOauthClient,
  useMcpOauthClients,
  useRotateMcpOauthClientSecret,
  useUpdateMcpOauthClient,
} from "@/lib/mcp-oauth-clients.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useSetCredentialsAction } from "../layout";

type McpOauthClient =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number];

export default function OAuthClientsPage() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";

  const { data: oauthClients = [], isPending } = useMcpOauthClients({
    search: search || undefined,
  });
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway"] },
  });
  const createMutation = useCreateMcpOauthClient();
  const updateMutation = useUpdateMcpOauthClient();
  const rotateMutation = useRotateMcpOauthClientSecret();
  const deleteMutation = useDeleteMcpOauthClient();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);
  const [deletingOAuthClient, setDeletingOAuthClient] =
    useState<McpOauthClient | null>(null);
  const [editingOAuthClient, setEditingOAuthClient] =
    useState<McpOauthClient | null>(null);
  const [rotatedCredentials, setRotatedCredentials] = useState<{
    clientId: string;
    clientSecret: string;
  } | null>(null);
  const [rotatingOAuthClient, setRotatingOAuthClient] =
    useState<McpOauthClient | null>(null);

  const setCredentialsAction = useSetCredentialsAction();
  useEffect(() => {
    setCredentialsAction(
      <Button onClick={() => setIsCreateDialogOpen(true)}>
        <Plus className="h-4 w-4" />
        Create OAuth Client
      </Button>,
    );
    return () => setCredentialsAction(null);
  }, [setCredentialsAction]);

  const columns: ColumnDef<McpOauthClient>[] = useMemo(
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
        id: "gateways",
        header: "Gateways",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.allowedGatewayIds.length}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatRelativeTimeFromNow(row.original.createdAt)}
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
                onClick: () => setRotatingOAuthClient(row.original),
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
    [],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-4">
        <SearchInput
          objectNamePlural="OAuth clients"
          searchFields={["name"]}
          paramName="search"
        />
      </div>

      <DataTable
        columns={columns}
        data={oauthClients}
        isLoading={isPending}
        emptyMessage="No OAuth clients registered. Create one for an application that calls MCP gateways."
        hasActiveFilters={Boolean(search)}
        filteredEmptyMessage="No OAuth clients match your filters. Try adjusting your search."
        onClearFilters={() =>
          updateQueryParams({
            search: null,
            page: "1",
          })
        }
      />

      <CreateOAuthClientDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        gateways={gateways}
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
        gateways={gateways}
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
        open={!!rotatingOAuthClient}
        onOpenChange={(open) => {
          if (!open) setRotatingOAuthClient(null);
        }}
        title="Rotate OAuth client secret"
        description={
          rotatingOAuthClient
            ? `Rotate the secret for ${rotatingOAuthClient.name}? Existing integrations using the current secret will not be able to request new access tokens.`
            : ""
        }
        onConfirm={async () => {
          if (!rotatingOAuthClient) return;
          const result = await rotateMutation.mutateAsync({
            id: rotatingOAuthClient.id,
          });
          if (result) {
            setRotatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
            });
          }
          setRotatingOAuthClient(null);
        }}
        isPending={rotateMutation.isPending}
        confirmLabel="Rotate secret"
        pendingLabel="Rotating..."
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
  gateways,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateways: AgentSelectorAgent[];
  onSubmit: (
    values: archestraApiTypes.CreateMcpOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setName("");
      setSelectedGatewayIds([]);
    }
  }, [open]);

  const canSubmit = name.trim().length > 0 && selectedGatewayIds.length > 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description="Register an application (a backend service, automation job, or bot) that can call MCP gateways with OAuth client credentials."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            name: name.trim(),
            allowedGatewayIds: selectedGatewayIds,
          });
          setName("");
          setSelectedGatewayIds([]);
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
            <Label>Allowed gateways</Label>
            <AgentSelector
              mode="multiple"
              flat
              agents={gateways}
              value={selectedGatewayIds}
              onValueChange={setSelectedGatewayIds}
              placeholder="Select gateways"
              searchPlaceholder="Search gateways"
              emptyMessage="No gateways found"
            />
          </div>
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
  gateways,
  onSubmit,
  isSubmitting,
}: {
  oauthClient: McpOauthClient | null;
  onOpenChange: (open: boolean) => void;
  gateways: AgentSelectorAgent[];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateMcpOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([]);

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedGatewayIds(oauthClient.allowedGatewayIds);
  }, [oauthClient]);

  const canSubmit =
    !!oauthClient && name.trim().length > 0 && selectedGatewayIds.length > 0;

  return (
    <FormDialog
      open={!!oauthClient}
      onOpenChange={onOpenChange}
      title="Edit OAuth Client"
      description="Update the gateways this OAuth client can access."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          if (!oauthClient) return;
          await onSubmit(oauthClient.id, {
            name: name.trim(),
            allowedGatewayIds: selectedGatewayIds,
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
            <Label>Allowed gateways</Label>
            <AgentSelector
              mode="multiple"
              flat
              agents={gateways}
              value={selectedGatewayIds}
              onValueChange={setSelectedGatewayIds}
              placeholder="Select gateways"
              searchPlaceholder="Search gateways"
              emptyMessage="No gateways found"
            />
          </div>
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
  const tokenEndpoint =
    typeof window === "undefined"
      ? "/api/auth/oauth2/token"
      : new URL("/api/auth/oauth2/token", window.location.origin).toString();

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
              <CopyableCode value={tokenEndpoint} />
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
