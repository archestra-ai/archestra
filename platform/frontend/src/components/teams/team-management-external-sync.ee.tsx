"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
  type IdentityProviderFormValues,
} from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { TeamSyncConfigForm } from "@/app/settings/identity-providers/_parts/team-sync-config-form.ee";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useIdentityProviders } from "@/lib/auth/identity-provider.query.ee";

type Team = archestraApiTypes.GetTeamsResponses["200"]["data"][number];
type ExternalGroup =
  archestraApiTypes.GetTeamExternalGroupsResponses["200"][number];
type IdentityProvider =
  archestraApiTypes.GetIdentityProvidersResponses["200"][number];

interface TeamManagementExternalSyncSectionProps {
  open: boolean;
  team: Team;
}

export function TeamManagementExternalSyncSection({
  open,
  team,
}: TeamManagementExternalSyncSectionProps) {
  const queryClient = useQueryClient();
  const { data: identityProviders = [] } = useIdentityProviders({
    enabled: open,
  });
  const [selectedIdentityProviderId, setSelectedIdentityProviderId] =
    useState("");
  const [newGroupIdentifier, setNewGroupIdentifier] = useState("");

  const selectedIdentityProvider = useMemo(
    () =>
      identityProviders.find(
        (provider) => provider.id === selectedIdentityProviderId,
      ) ?? identityProviders[0],
    [identityProviders, selectedIdentityProviderId],
  );

  useEffect(() => {
    if (!open) return;
    if (selectedIdentityProviderId) return;
    setSelectedIdentityProviderId(identityProviders[0]?.id ?? "");
  }, [identityProviders, open, selectedIdentityProviderId]);

  const { data: externalGroups = [], isLoading } = useQuery({
    queryKey: ["teamExternalGroups", team.id],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeamExternalGroups({
        path: { id: team.id },
      });
      return data ?? [];
    },
    enabled: open,
  });

  const addMutation = useMutation({
    mutationFn: async (groupIdentifier: string) => {
      const { error } = await archestraApiSdk.addTeamExternalGroup({
        path: { id: team.id },
        body: { groupIdentifier },
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["teamExternalGroups", team.id],
      });
      setNewGroupIdentifier("");
      toast.success("External group mapping added");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add external group mapping");
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (groupId: string) => {
      const { error } = await archestraApiSdk.removeTeamExternalGroup({
        path: { id: team.id, groupId },
      });
      if (error) throw new Error(error.error.message);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["teamExternalGroups", team.id],
      });
      toast.success("External group mapping removed");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove external group mapping");
    },
  });

  const handleAddGroup = () => {
    const trimmed = newGroupIdentifier.trim();
    if (!trimmed) {
      toast.error("Group identifier is required");
      return;
    }
    addMutation.mutate(trimmed);
  };

  if (identityProviders.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        Add an identity provider before configuring external group sync.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid max-w-3xl gap-4">
        <div className="space-y-2">
          <Label>Identity Provider</Label>
          <Select
            value={selectedIdentityProvider?.id}
            onValueChange={setSelectedIdentityProviderId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select an identity provider" />
            </SelectTrigger>
            <SelectContent>
              {identityProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.providerId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            Choose which IdP token to use for template testing and group
            extraction.
          </p>
        </div>

        {selectedIdentityProvider && (
          <IdentityProviderTeamSyncPanel
            identityProvider={selectedIdentityProvider}
          />
        )}
      </div>

      <Separator />

      <div className="space-y-6">
        <div className="space-y-2 max-w-3xl">
          <Label>Add External Group Mapping</Label>
          <div className="flex gap-2">
            <Input
              placeholder="e.g., archestra-admins, cn=engineering,ou=groups,dc=example,dc=com"
              value={newGroupIdentifier}
              onChange={(event) => setNewGroupIdentifier(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddGroup();
                }
              }}
            />
            <Button
              type="button"
              onClick={handleAddGroup}
              disabled={addMutation.isPending || !newGroupIdentifier.trim()}
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Map extracted SSO group identifiers to "{team.name}". Matching users
            are added to this team when they sign in.{" "}
            <ExternalDocsLink href={getDocsUrl(DocsPage.PlatformSsoTeamSync)}>
              Learn More
            </ExternalDocsLink>
          </p>
        </div>

        <div className="space-y-2">
          <Label>Linked External Groups ({externalGroups.length})</Label>
          {isLoading ? (
            <div className="py-4 text-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : externalGroups.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-center">
              <Link2 className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No external groups linked yet.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {externalGroups.map((group) => (
                <ExternalGroupRow
                  key={group.id}
                  group={group}
                  disabled={removeMutation.isPending}
                  onRemove={() => removeMutation.mutate(group.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IdentityProviderTeamSyncPanel({
  identityProvider,
}: {
  identityProvider: IdentityProvider;
}) {
  const form = useForm<IdentityProviderFormValues>({
    defaultValues: toIdentityProviderFormValues(identityProvider),
  });

  useEffect(() => {
    form.reset(toIdentityProviderFormValues(identityProvider));
  }, [form, identityProvider]);

  return (
    <Form {...form}>
      <TeamSyncConfigForm
        form={form}
        identityProviderId={identityProvider.id}
        embedded
        showEnabledField={false}
        groupsExpressionReadOnly
        groupsExpressionDescription="This extraction template is configured on the selected identity provider. Use the mapped group values below to control membership for this team."
      />
    </Form>
  );
}

function ExternalGroupRow({
  group,
  disabled,
  onRemove,
}: {
  group: ExternalGroup;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-mono truncate">{group.groupIdentifier}</p>
        <p className="text-xs text-muted-foreground">
          Added {new Date(group.createdAt).toLocaleDateString()}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        disabled={disabled}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
        <span className="sr-only">Remove external group</span>
      </Button>
    </div>
  );
}

function toIdentityProviderFormValues(
  provider: IdentityProvider,
): IdentityProviderFormValues {
  const isSaml = !!provider.samlConfig;
  return {
    providerId: provider.providerId,
    issuer: provider.issuer,
    ssoLoginEnabled: provider.ssoLoginEnabled ?? true,
    domain: provider.domain,
    providerType: isSaml ? "saml" : "oidc",
    roleMapping: {
      rules: [],
      ...provider.roleMapping,
    },
    teamSyncConfig: provider.teamSyncConfig ?? {
      enabled: true,
      groupsExpression: "",
    },
    ...(isSaml
      ? {
          samlConfig: provider.samlConfig ?? {
            issuer: "",
            entryPoint: "",
            cert: "",
            callbackUrl: "",
            spMetadata: {},
          },
        }
      : {
          oidcConfig: {
            issuer: "",
            pkce: true,
            enableRpInitiatedLogout: true,
            clientId: "",
            clientSecret: "",
            discoveryEndpoint: "",
            scopes: ["openid", "email", "profile"],
            mapping: {
              id: "sub",
              email: "email",
              name: "name",
            },
            overrideUserInfo: true,
            ...provider.oidcConfig,
          },
        }),
  };
}
