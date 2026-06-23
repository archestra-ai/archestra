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
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  formatProviderKeySummary,
  type ProviderApiKeyMap,
  providerApiKeyArrayToMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
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
  useCreateLlmOauthClient,
  useDeleteLlmOauthClient,
  useLlmOauthClients,
  useRotateLlmOauthClientSecret,
  useUpdateLlmOauthClient,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useSetCredentialsAction } from "../layout";

type LlmOauthClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"][number];
type GrantType = LlmOauthClient["grantType"];
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
      "A backend service or bot calls the proxy as itself, with no acting user, using provider keys you map to it.",
  },
  {
    value: "authorization_code",
    label: "On behalf of users (authorization code)",
    description:
      "A pre-registered app obtains user-scoped tokens, so the proxy resolves each user's own provider keys, cost limits, and policies.",
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
  const providerApiKeyIdFilter = searchParams.get("providerApiKeyId") || "all";

  const { data: oauthClients = [], isPending } = useLlmOauthClients({
    search: search || undefined,
    providerApiKeyId:
      providerApiKeyIdFilter === "all" ? undefined : providerApiKeyIdFilter,
  });
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const createMutation = useCreateLlmOauthClient();
  const updateMutation = useUpdateLlmOauthClient();
  const rotateMutation = useRotateLlmOauthClientSecret();
  const deleteMutation = useDeleteLlmOauthClient();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedCredentials | null>(null);
  const [providerApiKeyFilterOpen, setProviderApiKeyFilterOpen] =
    useState(false);
  const [deletingOAuthClient, setDeletingOAuthClient] =
    useState<LlmOauthClient | null>(null);
  const [editingOAuthClient, setEditingOAuthClient] =
    useState<LlmOauthClient | null>(null);
  const [rotatedCredentials, setRotatedCredentials] =
    useState<CreatedCredentials | null>(null);
  const [rotatingOAuthClient, setRotatingOAuthClient] =
    useState<LlmOauthClient | null>(null);

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
        id: "grantType",
        header: "Type",
        cell: ({ row }) => (
          <Badge variant="secondary">
            {GRANT_TYPE_LABEL[row.original.grantType]}
          </Badge>
        ),
      },
      {
        id: "proxies",
        header: "LLM Proxies",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.grantType === "authorization_code"
              ? "—"
              : row.original.allowedLlmProxyIds.length}
          </span>
        ),
      },
      {
        id: "providers",
        header: "Providers",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.grantType === "authorization_code"
              ? "—"
              : formatProviderKeySummary(row.original.providerApiKeys)}
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
        <LlmProviderApiKeyDropdown
          availableKeys={providerApiKeys}
          selectedApiKeyId={
            providerApiKeyIdFilter === "all" ? null : providerApiKeyIdFilter
          }
          open={providerApiKeyFilterOpen}
          onOpenChange={setProviderApiKeyFilterOpen}
          onSelectKey={(value) => {
            updateQueryParams({
              providerApiKeyId: value,
              page: "1",
            });
            setProviderApiKeyFilterOpen(false);
          }}
          triggerVariant="select"
          triggerClassName="w-full sm:w-[280px] h-9 text-sm"
          popoverClassName="w-[var(--radix-popover-trigger-width)]"
          allOptionLabel="All provider API keys"
          allOptionSelected={providerApiKeyIdFilter === "all"}
          onSelectAllOption={() => {
            updateQueryParams({
              providerApiKeyId: null,
              page: "1",
            });
            setProviderApiKeyFilterOpen(false);
          }}
        />
      </div>

      <DataTable
        columns={columns}
        data={oauthClients}
        isLoading={isPending}
        emptyMessage="No OAuth clients registered. Create one for backend services or bots that call LLM proxies."
        hasActiveFilters={Boolean(search || providerApiKeyIdFilter !== "all")}
        filteredEmptyMessage="No OAuth clients match your filters. Try adjusting your search."
        onClearFilters={() =>
          updateQueryParams({
            search: null,
            providerApiKeyId: null,
            page: "1",
          })
        }
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
  llmProxies,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  llmProxies: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    values: archestraApiTypes.CreateLlmOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [grantType, setGrantType] = useState<GrantType>("client_credentials");
  const [selectedProxyIds, setSelectedProxyIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [redirectUrisText, setRedirectUrisText] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setGrantType("client_credentials");
      setSelectedProxyIds([]);
      setProviderApiKeyIds({});
      setRedirectUrisText("");
    }
  }, [open]);

  const mappedProviderApiKeys = providerApiKeyMapToArray(providerApiKeyIds);
  const redirectUris = parseRedirectUris(redirectUrisText);
  const isAuthorizationCode = grantType === "authorization_code";
  const canSubmit =
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : selectedProxyIds.length > 0 && mappedProviderApiKeys.length > 0);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description="Register an application that authenticates to LLM proxies with OAuth."
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
                  allowedLlmProxyIds: selectedProxyIds,
                }
              : {
                  name: name.trim(),
                  grantType,
                  allowedLlmProxyIds: selectedProxyIds,
                  providerApiKeys: mappedProviderApiKeys,
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
              <ProxyGrantField
                llmProxies={llmProxies}
                value={selectedProxyIds}
                onValueChange={setSelectedProxyIds}
              />
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Allowed LLM proxies</Label>
                <AgentSelector
                  mode="multiple"
                  flat
                  agents={llmProxies}
                  value={selectedProxyIds}
                  onValueChange={setSelectedProxyIds}
                  placeholder="Select LLM proxies"
                  searchPlaceholder="Search LLM proxies"
                  emptyMessage="No LLM proxies found"
                />
              </div>

              <ProviderKeyAccessFields
                providerApiKeyIds={providerApiKeyIds}
                onProviderApiKeyIdsChange={setProviderApiKeyIds}
                providerApiKeys={providerApiKeys}
              />
            </>
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
  llmProxies,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  oauthClient: LlmOauthClient | null;
  onOpenChange: (open: boolean) => void;
  llmProxies: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateLlmOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedProxyIds, setSelectedProxyIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [redirectUrisText, setRedirectUrisText] = useState("");

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedProxyIds(oauthClient.allowedLlmProxyIds);
    setProviderApiKeyIds(providerApiKeyArrayToMap(oauthClient.providerApiKeys));
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
  }, [oauthClient]);

  // The grant type is fixed at creation, so only its own configuration is editable.
  const isAuthorizationCode = oauthClient?.grantType === "authorization_code";
  const mappedProviderApiKeys = providerApiKeyMapToArray(providerApiKeyIds);
  const redirectUris = parseRedirectUris(redirectUrisText);
  const canSubmit =
    !!oauthClient &&
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : selectedProxyIds.length > 0 && mappedProviderApiKeys.length > 0);

  return (
    <FormDialog
      open={!!oauthClient}
      onOpenChange={onOpenChange}
      title="Edit OAuth Client"
      description={
        isAuthorizationCode
          ? "Update the redirect URIs and proxy grant for this OAuth client."
          : "Update the LLM proxies and provider keys this OAuth client can use."
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
                  allowedLlmProxyIds: selectedProxyIds,
                }
              : {
                  name: name.trim(),
                  grantType: oauthClient.grantType,
                  allowedLlmProxyIds: selectedProxyIds,
                  providerApiKeys: mappedProviderApiKeys,
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
              <ProxyGrantField
                llmProxies={llmProxies}
                value={selectedProxyIds}
                onValueChange={setSelectedProxyIds}
              />
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Allowed LLM proxies</Label>
                <AgentSelector
                  mode="multiple"
                  flat
                  agents={llmProxies}
                  value={selectedProxyIds}
                  onValueChange={setSelectedProxyIds}
                  placeholder="Select LLM proxies"
                  searchPlaceholder="Search LLM proxies"
                  emptyMessage="No LLM proxies found"
                />
              </div>

              <ProviderKeyAccessFields
                providerApiKeyIds={providerApiKeyIds}
                onProviderApiKeyIdsChange={setProviderApiKeyIds}
                providerApiKeys={providerApiKeys}
              />
            </>
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

function ProxyGrantField({
  llmProxies,
  value,
  onValueChange,
}: {
  llmProxies: AgentSelectorAgent[];
  value: string[];
  onValueChange: (value: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>LLM proxy access grant (optional)</Label>
      <AgentSelector
        mode="multiple"
        flat
        agents={llmProxies}
        value={value}
        onValueChange={onValueChange}
        placeholder="Select LLM proxies to grant"
        searchPlaceholder="Search LLM proxies"
        emptyMessage="No LLM proxies found"
      />
      <p className="text-sm text-muted-foreground">
        Grants any user who authenticates through this client access to the
        selected LLM proxies — <strong>in addition to</strong> their own
        role-based access, even proxies they otherwise couldn't reach. Leave
        empty for pure identity passthrough (access stays governed by each
        user's permissions). Each user's own provider keys are still used.
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
                  <code>llm:proxy</code> scope.
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
