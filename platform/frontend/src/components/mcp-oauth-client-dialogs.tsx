"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { createdByFact } from "@/components/created-by-cell";
import { DetailFacts } from "@/components/detail-facts";
import {
  GatewayGrantField,
  OAUTH_CLIENT_SECTIONS,
  type OAuthClientSection,
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
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
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [activeSection, setActiveSection] =
    useState<OAuthClientSection>("general");
  // The permissions section keeps its edits in its own form. This dialog's
  // Save Changes is the only Save on screen, so it commits them too.
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );

  useEffect(() => {
    if (!oauthClient) return;
    setActiveSection("general");
    setName(oauthClient.name);
    setSelectedGatewayIds(oauthClient.allowedGatewayIds);
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
    setLabels(oauthClient.labels);
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
    <TabbedDialogShell
      open={!!oauthClient}
      onOpenChange={onOpenChange}
      title="Edit OAuth Client"
      description={
        isAuthorizationCode
          ? "Update the redirect URIs and gateway grant for this OAuth client."
          : "Update the gateways this OAuth client can access."
      }
      sidebarLabel={name.trim() || "OAuth client"}
      sidebarDescription="Agents & MCP gateways"
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={OAUTH_CLIENT_SECTIONS}
      onActiveSectionChange={setActiveSection}
      footer={
        <>
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
        </>
      }
      onSubmit={async (event) => {
        event.preventDefault();
        if (!oauthClient) return;
        const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
        await permissionsSave.current?.();
        await onSubmit(oauthClient.id, {
          name: name.trim(),
          grantType: oauthClient.grantType,
          allowedGatewayIds: selectedGatewayIds,
          ...(isAuthorizationCode && { redirectUris }),
          labels: finalLabels,
        });
      }}
    >
      <div hidden={activeSection !== "general"} className="space-y-4">
        {/* Provenance before the editable fields: who to ask before you
              change somebody else's credential. */}
        <DetailFacts facts={[createdByFact(oauthClient?.createdBy)]} />
        <div className="space-y-2">
          <Label htmlFor="edit-oauth-client-name">Name</Label>
          <Input
            id="edit-oauth-client-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="support-assistant-prod"
          />
        </div>
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>

      <div hidden={activeSection !== "access"} className="space-y-4">
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
      </div>

      {/* Kept mounted on every tab, so Save Changes commits its edits. */}
      <div hidden={activeSection !== "permissions"}>
        {/* SPDX-SnippetBegin
              SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
        {oauthClient && (
          <ResourceAccessSection
            resource="mcpOauthClient"
            id={oauthClient.id}
            registerSave={registerPermissionsSave}
            standalone
          />
        )}
        {/* SPDX-SnippetEnd */}
      </div>
    </TabbedDialogShell>
  );
}
