"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { CreatedByHeader } from "@/components/credential-billing/created-by-header";
import { ChoiceCards } from "@/components/oauth-client/choice-cards";
import { GatewayChecklist } from "@/components/oauth-client/gateway-checklist";
import { OAuthClientIdentityFields } from "@/components/oauth-client/identity-fields";
import {
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
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
  const [activeSection, setActiveSection] = useState<Section>("general");
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
    setActiveSection("general");
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
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={oauthClient.name}
      description={
        isAuthorizationCode
          ? "Signs users in. Tools act with each user's own identity."
          : "Calls the gateways and agents you pick, as itself."
      }
      sidebarLabel={name.trim() || "OAuth client"}
      sidebarDescription="MCP OAuth client"
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      isDirty={isDirty}
      activeSection={activeSection}
      navItems={[
        { id: "general", label: "General", status: oauthClient.clientId },
        ...(isAuthorizationCode
          ? [
              {
                id: "signin" as const,
                label: "Sign-in",
                status: `${redirectUris.length} redirect ${redirectUris.length === 1 ? "URI" : "URIs"}`,
              },
            ]
          : []),
        {
          id: "access",
          label: "Access",
          status:
            grantedGatewayIds.length > 0
              ? `${grantedGatewayIds.length} ${grantedGatewayIds.length === 1 ? "gateway" : "gateways"}`
              : "Each user's own access",
        },
        {
          id: "permissions",
          label: "Permissions",
          status: "Who can manage it",
        },
      ]}
      onActiveSectionChange={setActiveSection}
      headerExtra={
        <CreatedByHeader
          createdBy={oauthClient.createdBy}
          createdAt={oauthClient.createdAt}
        />
      }
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
      <div hidden={activeSection !== "general"} className="space-y-4">
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
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>

      {isAuthorizationCode && (
        <div hidden={activeSection !== "signin"}>
          <RedirectUrisField
            value={redirectUrisText}
            onChange={setRedirectUrisText}
          />
        </div>
      )}

      <div hidden={activeSection !== "access"} className="space-y-4">
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
          <GatewayChecklist
            label={
              isAuthorizationCode
                ? "Gateways to grant"
                : "Gateways and agents it can call"
            }
            idPrefix="edit-oauth-client-gateway"
            gateways={gateways}
            value={selectedGatewayIds}
            onValueChange={setSelectedGatewayIds}
          />
        )}
      </div>

      {/* Kept mounted on every tab, so Save Changes commits its edits. */}
      <div hidden={activeSection !== "permissions"}>
        {/* SPDX-SnippetBegin
              SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
        <ResourceAccessSection
          resource="mcpOauthClient"
          id={oauthClient.id}
          registerSave={registerPermissionsSave}
          onDirtyChange={setPermissionsDirty}
          standalone
        />
        {/* SPDX-SnippetEnd */}
      </div>
    </TabbedDialogShell>
  );
}

type Section = "general" | "signin" | "access" | "permissions";
