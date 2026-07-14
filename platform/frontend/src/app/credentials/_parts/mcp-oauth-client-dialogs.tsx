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

export type McpOauthClient =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number];
type GrantType = McpOauthClient["grantType"];

const GRANT_TYPE_OPTIONS: {
  value: GrantType;
  label: string;
  description: string;
}[] = [
  {
    value: "client_credentials",
    label: "Application (client credentials)",
    description:
      "A backend service or bot calls gateways or agents as itself, with no acting user. Scope it to specific gateways or agents.",
  },
  {
    value: "authorization_code",
    label: "On behalf of users (authorization code)",
    description:
      "A pre-registered app obtains user-scoped tokens, so gateway tools resolve each user's own identity and connections.",
  },
];

export function CreateOAuthClientDialog({
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
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setName("");
      setGrantType("client_credentials");
      setSelectedGatewayIds([]);
      setRedirectUrisText("");
      setScope("personal");
      setTeamIds([]);
    }
  }, [open]);

  const redirectUris = parseRedirectUris(redirectUrisText);
  const isAuthorizationCode = grantType === "authorization_code";
  const canSubmit =
    name.trim().length > 0 &&
    (scope !== "team" || teamIds.length > 0) &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : selectedGatewayIds.length > 0);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description="Register an application that authenticates to MCP gateways or agents with OAuth."
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          await onSubmit({
            name: name.trim(),
            grantType,
            allowedGatewayIds: selectedGatewayIds,
            ...(isAuthorizationCode && { redirectUris }),
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
              <Label>Allowed gateways &amp; agents</Label>
              <AgentSelector
                mode="multiple"
                agents={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
                placeholder="Select gateways or agents"
                searchPlaceholder="Search gateways and agents"
                emptyMessage="No gateways or agents found"
              />
            </div>
          )}

          <OauthClientVisibilityField
            resource="mcpOauthClient"
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
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

export function EditOAuthClientDialog({
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
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedGatewayIds(oauthClient.allowedGatewayIds);
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
    setScope(oauthClient.scope);
    setTeamIds(oauthClient.teams.map((team) => team.id));
  }, [oauthClient]);

  // The grant type is fixed at creation, so only its own configuration is editable.
  const isAuthorizationCode = oauthClient?.grantType === "authorization_code";
  const redirectUris = parseRedirectUris(redirectUrisText);
  const canSubmit =
    !!oauthClient &&
    name.trim().length > 0 &&
    (scope !== "team" || teamIds.length > 0) &&
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
          await onSubmit(oauthClient.id, {
            name: name.trim(),
            grantType: oauthClient.grantType,
            allowedGatewayIds: selectedGatewayIds,
            ...(isAuthorizationCode && { redirectUris }),
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
              <Label>Allowed gateways &amp; agents</Label>
              <AgentSelector
                mode="multiple"
                agents={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
                placeholder="Select gateways or agents"
                searchPlaceholder="Search gateways and agents"
                emptyMessage="No gateways or agents found"
              />
            </div>
          )}

          <OauthClientVisibilityField
            resource="mcpOauthClient"
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
            initialScope={oauthClient?.scope}
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
