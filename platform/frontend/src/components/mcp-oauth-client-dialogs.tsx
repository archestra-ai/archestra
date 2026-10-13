"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { CreatedByHeader } from "@/components/credential-billing/created-by-header";
import { ChoiceCards } from "@/components/oauth-client/choice-cards";
import { GatewayPicker } from "@/components/oauth-client/gateway-picker";
import { OAuthClientIdentityFields } from "@/components/oauth-client/identity-fields";
import {
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";

export type McpOauthClient =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number];

export function EditOAuthClientDialog({
  oauthClient,
  onOpenChange,
  gateways,
  onSubmit,
  onRotateSecret,
  isSubmitting,
}: {
  oauthClient: McpOauthClient | null;
  onOpenChange: (open: boolean) => void;
  gateways: AgentSelectorAgent[];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateMcpOauthClientData["body"],
  ) => Promise<void>;
  /** Hands the client to the page's rotate-secret confirmation. */
  onRotateSecret?: (oauthClient: McpOauthClient) => void;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([]);
  const [grantsGateways, setGrantsGateways] = useState(false);
  const [redirectUrisText, setRedirectUrisText] = useState("");
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  // The permissions section keeps its edits in its own form. This dialog's
  // Save Changes is the only Save on screen, so it commits them too.
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );
  const [permissionsDirty, setPermissionsDirty] = useState(false);

  useEffect(() => {
    if (!oauthClient) return;
    setName(oauthClient.name);
    setSelectedGatewayIds(oauthClient.allowedGatewayIds);
    setGrantsGateways(oauthClient.allowedGatewayIds.length > 0);
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
    setLabels(oauthClient.labels);
    initialSnapshotRef.current = {
      name: oauthClient.name,
      selectedGatewayIds: oauthClient.allowedGatewayIds,
      redirectUrisText: oauthClient.redirectUris.join("\n"),
      labels: oauthClient.labels,
    };
  }, [oauthClient]);

  if (!oauthClient) return null;

  // The grant type is fixed at creation, so only its own configuration is editable.
  const isAuthorizationCode = oauthClient.grantType === "authorization_code";
  const redirectUris = parseRedirectUris(redirectUrisText);
  // Users who sign in keep their own access unless the client grants more.
  const grantedGatewayIds =
    isAuthorizationCode && !grantsGateways ? [] : selectedGatewayIds;
  const canSubmit =
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0 &&
        (!grantsGateways || selectedGatewayIds.length > 0)
      : selectedGatewayIds.length > 0);
  const isDirty =
    permissionsDirty ||
    (initialSnapshotRef.current !== null &&
      hasUnsavedChanges(initialSnapshotRef.current, {
        name,
        selectedGatewayIds: grantedGatewayIds,
        redirectUrisText,
        labels,
      }));

  return (
    <StandardFormDialog
      open
      onOpenChange={onOpenChange}
      title={oauthClient.name}
      description={
        isAuthorizationCode
          ? "Signs users in. Tools act with each user's own identity."
          : "Calls the gateways and agents you pick, as itself."
      }
      isDirty={isDirty}
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={!canSubmit || isSubmitting}>
            Save Changes
          </Button>
        </>
      }
      onSubmit={async (event) => {
        event.preventDefault();
        const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
        await permissionsSave.current?.();
        await onSubmit(oauthClient.id, {
          name: name.trim(),
          grantType: oauthClient.grantType,
          allowedGatewayIds: grantedGatewayIds,
          ...(isAuthorizationCode && { redirectUris }),
          labels: finalLabels,
        });
      }}
    >
      <div className="space-y-4">
        <CreatedByHeader
          createdBy={oauthClient.createdBy}
          createdAt={oauthClient.createdAt}
        />
        <div className="space-y-2">
          <Label htmlFor="edit-oauth-client-name">Name</Label>
          <Input
            id="edit-oauth-client-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="support-assistant-prod"
          />
        </div>
        <OAuthClientIdentityFields
          kindLabel={
            isAuthorizationCode
              ? "Agents & MCP gateways · for its users"
              : "Agents & MCP gateways · as itself"
          }
          clientId={oauthClient.clientId}
          onRotateSecret={
            onRotateSecret ? () => onRotateSecret(oauthClient) : undefined
          }
        />

        {isAuthorizationCode && (
          <div>
            <RedirectUrisField
              value={redirectUrisText}
              onChange={setRedirectUrisText}
            />
          </div>
        )}

        <div className="space-y-4">
          {isAuthorizationCode && (
            <ChoiceCards
              label="What can signed-in users reach?"
              idPrefix="edit-oauth-client-access"
              columns={1}
              value={grantsGateways ? "grant" : "own"}
              onValueChange={(next) => setGrantsGateways(next === "grant")}
              options={[
                {
                  value: "own",
                  title: "Only what each user can already reach",
                  description:
                    "Access stays governed by each user's own role and teams.",
                },
                {
                  value: "grant",
                  title: "Also these gateways, for everyone who signs in",
                  description:
                    "Adds the gateways below on top of each user's own access.",
                },
              ]}
            />
          )}
          {(!isAuthorizationCode || grantsGateways) && (
            <GatewayPicker
              label={
                isAuthorizationCode
                  ? "Gateways to grant"
                  : "Gateways and agents it can call"
              }
              gateways={gateways}
              value={selectedGatewayIds}
              onValueChange={setSelectedGatewayIds}
            />
          )}
        </div>
        {/* SPDX-SnippetBegin
              SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
        <ResourceAccessSection
          resource="mcpOauthClient"
          id={oauthClient.id}
          registerSave={registerPermissionsSave}
          onDirtyChange={setPermissionsDirty}
        />
        {/* SPDX-SnippetEnd */}
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>
    </StandardFormDialog>
  );
}
