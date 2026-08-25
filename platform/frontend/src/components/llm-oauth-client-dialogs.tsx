"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { useEffect, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import {
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
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

type LlmOauthClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"]["data"][number];

export function EditOAuthClientDialog({
  oauthClient,
  onOpenChange,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  oauthClient: LlmOauthClient | null;
  onOpenChange: (open: boolean) => void;
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateLlmOauthClientData["body"],
  ) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [redirectUrisText, setRedirectUrisText] = useState("");
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
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
      : mappedProviderApiKeys.length > 0);

  return (
    <FormDialog
      open={!!oauthClient}
      onOpenChange={onOpenChange}
      title="Edit OAuth Client"
      description={
        isAuthorizationCode
          ? "Update the redirect URIs for this OAuth client."
          : "Update the provider keys this OAuth client can use."
      }
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          if (!oauthClient) return;
          await onSubmit(oauthClient.id, {
            name: name.trim(),
            grantType: oauthClient.grantType,
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
            <RedirectUrisField
              value={redirectUrisText}
              onChange={setRedirectUrisText}
            />
          ) : (
            <ProviderKeyAccessFields
              providerApiKeyIds={providerApiKeyIds}
              onProviderApiKeyIdsChange={setProviderApiKeyIds}
              providerApiKeys={providerApiKeys}
            />
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
