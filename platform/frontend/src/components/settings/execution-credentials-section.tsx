"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
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
import { toast } from "sonner";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExecutionCredentialConnectionDialog } from "@/components/execution-credential-connection-dialog";
import { ExecutionCredentialIcon } from "@/components/execution-credential-icon";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import {
  type ExecutionCredentialDefinition,
  useCreateExecutionCredential,
  useDeleteExecutionCredential,
  useDeleteExecutionCredentialConnection,
  useExecutionCredentials,
  useExecutionCredentialUsage,
  useUpdateExecutionCredential,
} from "@/lib/execution-credentials.query";
import { cn } from "@/lib/utils";

export function ExecutionCredentialsSection() {
  const definitions = useExecutionCredentials();
  const byosEnabled = useFeature("byosEnabled");
  const [editing, setEditing] = useState<ExecutionCredentialDefinition | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const [deleting, setDeleting] =
    useState<ExecutionCredentialDefinition | null>(null);
  const deleteDefinition = useDeleteExecutionCredential();
  const disconnect = useDeleteExecutionCredentialConnection();

  return (
    <section className="scroll-mt-24 border-t pt-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold leading-6">
            Execution credentials
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            Define reusable credentials without storing secrets in Agent
            settings. Each credential is either supplied privately by every user
            or shared once by the organization.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformExecutionCredentials)}
            >
              View credential setup
            </ExternalDocsLink>
          </p>
        </div>
        <WithPermissions
          permissions={{ agentSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={!hasPermission}
              onClick={() => setCreating(true)}
            >
              <Plus className="size-4" />
              Add credential
            </Button>
          )}
        </WithPermissions>
      </div>

      {definitions.isError ? (
        <QueryLoadError
          className="mt-4"
          title="Couldn't load execution credentials"
          onRetry={() => definitions.refetch()}
        />
      ) : (
        <div className="mt-4 divide-y overflow-hidden rounded-xl border bg-card">
          {(definitions.data ?? []).map((definition) => (
            <CredentialRow
              key={definition.key}
              definition={definition}
              onConnect={() => setConnecting(definition)}
              onDisconnect={() =>
                disconnect.mutate(
                  { key: definition.key, scope: "organization" },
                  {
                    onSuccess: () =>
                      toast.success(`${definition.name} disconnected`),
                  },
                )
              }
              onEdit={() => setEditing(definition)}
              onDelete={() => setDeleting(definition)}
            />
          ))}
          {!definitions.isPending && definitions.data?.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">
              No execution credentials yet.
            </p>
          )}
        </div>
      )}

      {(creating || editing) && (
        <CredentialDefinitionDialog
          definition={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
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
      <DeleteCredentialDialog
        definition={deleting}
        isPending={deleteDefinition.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => {
          if (!deleting) return;
          deleteDefinition.mutate(deleting.key, {
            onSuccess: () => {
              toast.success(`${deleting.name} deleted`);
              setDeleting(null);
            },
          });
        }}
      />
    </section>
  );
}

function CredentialRow({
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
  return (
    <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <div
        className={cn(
          "flex min-w-0 flex-1 gap-3",
          hasCredentialDescription(definition) ? "items-start" : "items-center",
        )}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
          <ExecutionCredentialIcon icon={definition.icon} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="truncate text-sm font-medium">{definition.name}</h3>
            {definition.builtIn && (
              <span className="text-xs text-muted-foreground">Built in</span>
            )}
          </div>
          <CredentialDefinitionDescription definition={definition} />
          <p className="mt-1 text-xs text-muted-foreground/80">
            {credentialScopeLabel(definition)}
          </p>
        </div>
      </div>
      <WithPermissions
        permissions={{ agentSettings: ["update"] }}
        noPermissionHandle="tooltip"
      >
        {({ hasPermission }) => (
          <div className="flex shrink-0 items-center gap-2 pl-[52px] sm:pl-0">
            {definition.allowOrganization && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label={
                      definition.organizationConfigured
                        ? `Replace ${definition.name}`
                        : `Connect ${definition.name}`
                    }
                    disabled={!hasPermission}
                    onClick={onConnect}
                  >
                    {definition.organizationConfigured ? (
                      <RefreshCw className="size-4" />
                    ) : (
                      <Plug className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {definition.organizationConfigured ? "Replace" : "Connect"}
                </TooltipContent>
              </Tooltip>
            )}
            {definition.organizationConfigured && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Disconnect ${definition.name}`}
                    className="text-destructive hover:text-destructive"
                    disabled={!hasPermission}
                    onClick={onDisconnect}
                  >
                    <Unplug className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Disconnect</TooltipContent>
              </Tooltip>
            )}
            {!definition.builtIn && (
              <>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit ${definition.name}`}
                  disabled={!hasPermission}
                  onClick={onEdit}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${definition.name}`}
                  disabled={!hasPermission}
                  onClick={onDelete}
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            )}
          </div>
        )}
      </WithPermissions>
    </div>
  );
}

function CredentialDefinitionDescription({
  definition,
}: {
  definition: ExecutionCredentialDefinition;
}) {
  if (!hasCredentialDescription(definition)) return null;
  return (
    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
      {definition.description}
    </p>
  );
}

function hasCredentialDescription(
  definition: ExecutionCredentialDefinition,
): boolean {
  return definition.description.trim().length > 0;
}

function CredentialDefinitionDialog({
  definition,
  onClose,
}: {
  definition: ExecutionCredentialDefinition | null;
  onClose: () => void;
}) {
  const create = useCreateExecutionCredential();
  const update = useUpdateExecutionCredential();
  const [name, setName] = useState(definition?.name ?? "");
  const [description, setDescription] = useState(definition?.description ?? "");
  const [icon, setIcon] = useState<string | null>(definition?.icon ?? null);
  const [scope, setScope] = useState<CredentialDefinitionScope>(
    definition ? scopeFromDefinition(definition) : "personal",
  );
  const key = definition?.key ?? slugifyCredentialKey(name);
  const pending = create.isPending || update.isPending;
  const valid = name.trim() && key.trim();

  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={definition ? `Edit ${definition.name}` : "Add credential"}
      description="Define a secret that Agents can request and people can connect once."
      size="small"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        const onSuccess = () => {
          toast.success(definition ? `${name} updated` : `${name} added`);
          onClose();
        };
        if (definition) {
          update.mutate(
            {
              key: definition.key,
              body: {
                description,
                icon,
              },
            },
            { onSuccess },
          );
          return;
        }
        create.mutate(
          {
            key,
            name,
            description,
            icon,
            ...scopeToAllowedValues(scope),
          },
          { onSuccess },
        );
      }}
      bodyClassName="space-y-4"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || pending}>
            {pending ? "Saving…" : definition ? "Save changes" : "Add"}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="credential-name">Name</Label>
        <div className="flex items-center gap-3">
          <AgentIconPicker
            value={icon}
            onChange={setIcon}
            showLogos
            className="size-9 rounded-md"
          />
          <Input
            id="credential-name"
            autoFocus={!definition}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="GitLab PAT"
            disabled={Boolean(definition)}
          />
        </div>
        {definition ? (
          <p className="text-xs text-muted-foreground">
            Existing Agents may depend on this credential, so its name cannot be
            changed.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="credential-description">Description</Label>
        <p className="text-xs text-muted-foreground">
          Shown when people choose or connect this credential.
        </p>
        <Textarea
          id="credential-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this credential unlocks"
          rows={2}
        />
      </div>

      {!definition && (
        <div className="space-y-2">
          <Label htmlFor="credential-scope">
            Who provides this credential?
          </Label>
          <p className="text-xs text-muted-foreground">
            Choose whether each person supplies a private value or admins
            maintain one shared value.
          </p>
          <Select
            value={scope}
            onValueChange={(value: CredentialDefinitionScope) =>
              setScope(value)
            }
          >
            <SelectTrigger id="credential-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem
                value="personal"
                description="Each person connects a private value for their own Agent runs."
              >
                Each user provides their own
              </SelectItem>
              <SelectItem
                value="organization"
                description="An admin connects one value shared by Agent runs in the organization."
              >
                One value for the organization
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </StandardFormDialog>
  );
}

function slugifyCredentialKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
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
    !!definition,
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
              <p>
                Remove this credential from these Agents before deleting it:
              </p>
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
              Connected values for {definition?.name ?? "this credential"} will
              also be deleted.
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

type CredentialDefinitionScope = "personal" | "organization";

function scopeFromDefinition(
  definition: Pick<
    ExecutionCredentialDefinition,
    "allowPersonal" | "allowOrganization"
  >,
): CredentialDefinitionScope {
  return definition.allowPersonal ? "personal" : "organization";
}

function scopeToAllowedValues(scope: CredentialDefinitionScope): {
  allowPersonal: boolean;
  allowOrganization: boolean;
} {
  return {
    allowPersonal: scope === "personal",
    allowOrganization: scope === "organization",
  };
}

function credentialScopeLabel(
  definition: Pick<
    ExecutionCredentialDefinition,
    "allowPersonal" | "allowOrganization"
  >,
): string {
  if (definition.allowPersonal && definition.allowOrganization) {
    return "Available as a personal connection";
  }
  return definition.allowPersonal
    ? "Available as a personal connection"
    : "Available as an organization connection";
}
