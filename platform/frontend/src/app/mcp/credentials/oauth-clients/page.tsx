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
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
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
type GrantType = McpOauthClient["grantType"];
type CreatedCredentials = {
  clientId: string;
  clientSecret: string;
  grantType: GrantType;
};

const GRANT_TYPE_OPTIONS: {
  value: GrantType;
  label: string;
  description: string;
}[] = [
  {
    value: "client_credentials",
    label: "Application (client credentials)",
    description:
      "A backend service or bot calls gateways as itself, with no acting user. Scope it to specific gateways.",
  },
  {
    value: "authorization_code",
    label: "On behalf of users (authorization code)",
    description:
      "A pre-registered app obtains user-scoped tokens, so gateway tools resolve each user's own identity and connections.",
  },
];

const GRANT_TYPE_LABEL: Record<GrantType, string> = {
  client_credentials: "Application",
  authorization_code: "User-delegated",
};

function parseRedirectUris(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function OAuthClientsPage() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";

  const {
    data: oauthClients = [],
    isPending,
    isLoadingError: isOauthClientsLoadError,
    refetch: refetchOauthClients,
  } = useMcpOauthClients({
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
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedCredentials | null>(null);
  const [deletingOAuthClient, setDeletingOAuthClient] =
    useState<McpOauthClient | null>(null);
  const [editingOAuthClient, setEditingOAuthClient] =
    useState<McpOauthClient | null>(null);
  const [rotatedCredentials, setRotatedCredentials] =
    useState<CreatedCredentials | null>(null);
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
        id: "grantType",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant="secondary">
            {GRANT_TYPE_LABEL[row.original.grantType]}
          </Badge>
        ),
      },
      {
        id: "scope",
        header: "Gateways / Redirects",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.grantType === "authorization_code"
              ? `${row.original.redirectUris.length} redirect URI(s)`
              : `${row.original.allowedGatewayIds.length} gateway(s)`}
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

      {isOauthClientsLoadError ? (
        <QueryLoadError
          title="Couldn't load your OAuth clients"
          onRetry={() => refetchOauthClients()}
        />
      ) : (
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
      )}

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
              grantType: result.grantType,
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
              grantType: result.grantType,
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
  const [grantType, setGrantType] = useState<GrantType>("client_credentials");
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([]);
  const [redirectUrisText, setRedirectUrisText] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setGrantType("client_credentials");
      setSelectedGatewayIds([]);
      setRedirectUrisText("");
    }
  }, [open]);

  const redirectUris = parseRedirectUris(redirectUrisText);
  const isAuthorizationCode = grantType === "authorization_code";
  const canSubmit =
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : selectedGatewayIds.length > 0);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description="Register an application that authenticates to MCP gateways with OAuth."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit(
            isAuthorizationCode
              ? {
                  name: name.trim(),
                  grantType,
                  redirectUris,
                  allowedGatewayIds: selectedGatewayIds,
                }
              : {
                  name: name.trim(),
                  grantType,
                  allowedGatewayIds: selectedGatewayIds,
                },
          );
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

          <GrantTypeField value={grantType} onChange={setGrantType} />

          {isAuthorizationCode ? (
            <>
              <RedirectUrisField
                value={redirectUrisText}
                onChange={setRedirectUrisText}
              />
              <GatewayGrantField
                gateways={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
              />
            </>
          ) : (
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
          )}
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
  const [redirectUrisText, setRedirectUrisText] = useState("");

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedGatewayIds(oauthClient.allowedGatewayIds);
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
  }, [oauthClient]);

  // The grant type is fixed at creation, so only its own configuration is editable.
  const isAuthorizationCode = oauthClient?.grantType === "authorization_code";
  const redirectUris = parseRedirectUris(redirectUrisText);
  const canSubmit =
    !!oauthClient &&
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : selectedGatewayIds.length > 0);

  return (
    <FormDialog
      open={!!oauthClient}
      onOpenChange={onOpenChange}
      title="Edit OAuth Client"
      description={
        isAuthorizationCode
          ? "Update the redirect URIs and gateway grant for this OAuth client."
          : "Update the gateways this OAuth client can access."
      }
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          if (!oauthClient) return;
          await onSubmit(
            oauthClient.id,
            isAuthorizationCode
              ? {
                  name: name.trim(),
                  grantType: oauthClient.grantType,
                  redirectUris,
                  allowedGatewayIds: selectedGatewayIds,
                }
              : {
                  name: name.trim(),
                  grantType: oauthClient.grantType,
                  allowedGatewayIds: selectedGatewayIds,
                },
          );
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

          {isAuthorizationCode ? (
            <>
              <RedirectUrisField
                value={redirectUrisText}
                onChange={setRedirectUrisText}
              />
              <GatewayGrantField
                gateways={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
              />
            </>
          ) : (
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
          )}
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

function GrantTypeField({
  value,
  onChange,
}: {
  value: GrantType;
  onChange: (value: GrantType) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Grant type</Label>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as GrantType)}
        className="gap-2"
      >
        {GRANT_TYPE_OPTIONS.map((option) => (
          <Label
            key={option.value}
            htmlFor={`grant-type-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[:checked]:border-primary"
          >
            <RadioGroupItem
              id={`grant-type-${option.value}`}
              value={option.value}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <div className="font-medium">{option.label}</div>
              <p className="text-sm text-muted-foreground">
                {option.description}
              </p>
            </div>
          </Label>
        ))}
      </RadioGroup>
    </div>
  );
}

function RedirectUrisField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="oauth-client-redirect-uris">Redirect URIs</Label>
      <Textarea
        id="oauth-client-redirect-uris"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={"https://your-app.example.com/oauth/callback"}
        rows={3}
      />
      <p className="text-sm text-muted-foreground">
        The registering application's own callback URL(s) — where users are sent
        after they authorize, not an address on this server. Must match the
        <code className="mx-1">redirect_uri</code>the app sends. One per line.
      </p>
    </div>
  );
}

function GatewayGrantField({
  gateways,
  value,
  onValueChange,
}: {
  gateways: AgentSelectorAgent[];
  value: string[];
  onValueChange: (value: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Gateway access grant (optional)</Label>
      <AgentSelector
        mode="multiple"
        flat
        agents={gateways}
        value={value}
        onValueChange={onValueChange}
        placeholder="Select gateways to grant"
        searchPlaceholder="Search gateways"
        emptyMessage="No gateways found"
      />
      <p className="text-sm text-muted-foreground">
        Grants any user who authenticates through this client access to the
        selected gateways — <strong>in addition to</strong> their own role-based
        access, even gateways they otherwise couldn't reach. Leave empty for
        pure identity passthrough (access stays governed by each user's
        permissions).
      </p>
    </div>
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
  credentials: CreatedCredentials | null;
}) {
  const endpoint = (path: string) =>
    typeof window === "undefined"
      ? path
      : new URL(path, window.location.origin).toString();
  const isAuthorizationCode = credentials?.grantType === "authorization_code";

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
            {isAuthorizationCode && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <KeyRound className="h-4 w-4" />
                  Authorization endpoint
                </div>
                <CopyableCode value={endpoint("/api/auth/oauth2/authorize")} />
                <p className="mt-2 text-muted-foreground">
                  Use the authorization code flow with PKCE and the{" "}
                  <code>mcp</code> scope.
                </p>
              </div>
            )}
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <KeyRound className="h-4 w-4" />
                Token endpoint
              </div>
              <CopyableCode value={endpoint("/api/auth/oauth2/token")} />
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
