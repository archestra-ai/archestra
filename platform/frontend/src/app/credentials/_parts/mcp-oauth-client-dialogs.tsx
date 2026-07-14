"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { useEffect, useState } from "react";
import {
  GatewayGrantField,
  parseRedirectUris,
  RedirectUrisField,
} from "@/app/credentials/_parts/oauth-client-form-fields";
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

export type McpOauthClient =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number];

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
