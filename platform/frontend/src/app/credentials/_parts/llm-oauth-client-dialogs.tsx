"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { useEffect, useState } from "react";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { FormDialog } from "@/components/form-dialog";
import { OauthClientVisibilityField } from "@/components/oauth-client-visibility-field";
import {
  type ProviderApiKeyMap,
  providerApiKeyArrayToMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

export type LlmOauthClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"][number];
type GrantType = LlmOauthClient["grantType"];

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

export function CreateOAuthClientDialog({
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
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setName("");
      setGrantType("client_credentials");
      setSelectedProxyIds([]);
      setProviderApiKeyIds({});
      setRedirectUrisText("");
      setScope("personal");
      setTeamIds([]);
    }
  }, [open]);

  const mappedProviderApiKeys = providerApiKeyMapToArray(providerApiKeyIds);
  const redirectUris = parseRedirectUris(redirectUrisText);
  const isAuthorizationCode = grantType === "authorization_code";
  const canSubmit =
    name.trim().length > 0 &&
    (scope !== "team" || teamIds.length > 0) &&
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
          await onSubmit({
            name: name.trim(),
            grantType,
            allowedLlmProxyIds: selectedProxyIds,
            ...(isAuthorizationCode
              ? { redirectUris }
              : { providerApiKeys: mappedProviderApiKeys }),
            scope,
            teams: scope === "team" ? teamIds : [],
          });
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

          <OauthClientVisibilityField
            resource="llmOauthClient"
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
          />

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

export function EditOAuthClientDialog({
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
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedProxyIds(oauthClient.allowedLlmProxyIds);
    setProviderApiKeyIds(providerApiKeyArrayToMap(oauthClient.providerApiKeys));
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
    setScope(oauthClient.scope);
    setTeamIds(oauthClient.teams.map((team) => team.id));
  }, [oauthClient]);

  // The grant type is fixed at creation, so only its own configuration is editable.
  const isAuthorizationCode = oauthClient?.grantType === "authorization_code";
  const mappedProviderApiKeys = providerApiKeyMapToArray(providerApiKeyIds);
  const redirectUris = parseRedirectUris(redirectUrisText);
  const canSubmit =
    !!oauthClient &&
    name.trim().length > 0 &&
    (scope !== "team" || teamIds.length > 0) &&
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
          await onSubmit(oauthClient.id, {
            name: name.trim(),
            grantType: oauthClient.grantType,
            allowedLlmProxyIds: selectedProxyIds,
            ...(isAuthorizationCode
              ? { redirectUris }
              : { providerApiKeys: mappedProviderApiKeys }),
            scope,
            teams: scope === "team" ? teamIds : [],
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

          <OauthClientVisibilityField
            resource="llmOauthClient"
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
            initialScope={oauthClient?.scope}
          />

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

// ===
// Internal helpers
// ===

function parseRedirectUris(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
