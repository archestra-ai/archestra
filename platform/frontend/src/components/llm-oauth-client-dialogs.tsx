"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import {
  BudgetFields,
  type SpendCapValue,
  summarizeBudget,
  UsersPayNotice,
} from "@/components/credential-billing/budget-fields";
import { CreatedByHeader } from "@/components/credential-billing/created-by-header";
import { ProviderKeyBoxes } from "@/components/credential-billing/provider-key-boxes";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { OAuthClientIdentityFields } from "@/components/oauth-client/identity-fields";
import {
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import { useHasPermissions } from "@/lib/auth/auth.query";

type LlmOauthClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"]["data"][number];

export function EditOAuthClientDialog({
  oauthClient,
  onOpenChange,
  providerApiKeys,
  onSubmit,
  onRotateSecret,
  isSubmitting,
}: {
  oauthClient: LlmOauthClient | null;
  onOpenChange: (open: boolean) => void;
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    id: string,
    values: archestraApiTypes.UpdateLlmOauthClientData["body"],
  ) => Promise<void>;
  /** Hands the client to the page's rotate-secret confirmation. */
  onRotateSecret?: (oauthClient: LlmOauthClient) => void;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState("");
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ProviderApiKeyMappings>([]);
  const [redirectUrisText, setRedirectUrisText] = useState("");
  const [billingTeamId, setBillingTeamId] = useState<string | null>(null);
  const [spendCap, setSpendCap] = useState<SpendCapValue>(null);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [activeSection, setActiveSection] = useState<Section>("general");
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const { data: canManageLimits } = useHasPermissions({
    llmLimit: ["update", "delete"],
  });
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
    const initialKeys = oauthClient.providerApiKeys.map(
      ({ provider, providerApiKeyId }) => ({ provider, providerApiKeyId }),
    );
    const initialCap = oauthClient.spendCap
      ? {
          limitValue: oauthClient.spendCap.limitValue,
          cleanupInterval: oauthClient.spendCap.cleanupInterval,
        }
      : null;
    setActiveSection("general");
    setName(oauthClient.name);
    setProviderApiKeyIds(initialKeys);
    setRedirectUrisText(oauthClient.redirectUris.join("\n"));
    setBillingTeamId(oauthClient.billingTeam?.id ?? null);
    setSpendCap(initialCap);
    setLabels(oauthClient.labels);
    initialSnapshotRef.current = {
      name: oauthClient.name,
      providerApiKeyIds: initialKeys,
      redirectUrisText: oauthClient.redirectUris.join("\n"),
      billingTeamId: oauthClient.billingTeam?.id ?? null,
      spendCap: initialCap,
      labels: oauthClient.labels,
    };
  }, [oauthClient]);

  if (!oauthClient) return null;

  // The grant type is fixed at creation, so only its own configuration is editable.
  const isAuthorizationCode = oauthClient.grantType === "authorization_code";
  const redirectUris = parseRedirectUris(redirectUrisText);
  const canSubmit =
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : providerApiKeyIds.length > 0);
  const initial = initialSnapshotRef.current;
  const capChanged =
    initial !== null &&
    hasUnsavedChanges({ spendCap: initial.spendCap }, { spendCap });
  const isDirty =
    permissionsDirty ||
    (initial !== null &&
      hasUnsavedChanges(initial, {
        name,
        providerApiKeyIds,
        redirectUrisText,
        billingTeamId,
        spendCap,
        labels,
      }));
  const providerCount = providerApiKeyIds.length;

  return (
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={oauthClient.name}
      description={
        isAuthorizationCode
          ? "Signs users in for the LLM Proxy. Each user's own keys and limits apply."
          : "Calls the LLM Proxy as itself with the provider keys it is given."
      }
      sidebarLabel={name.trim() || "OAuth client"}
      sidebarDescription="LLM Proxy OAuth client"
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      isDirty={isDirty}
      activeSection={activeSection}
      navItems={[
        { id: "general", label: "General", status: oauthClient.clientId },
        ...(!isAuthorizationCode
          ? [
              {
                id: "keys" as const,
                label: "Provider keys",
                status: `${providerCount} ${providerCount === 1 ? "provider" : "providers"}`,
              },
            ]
          : []),
        {
          id: "budget",
          label: "Budget",
          status: isAuthorizationCode
            ? summarizeBudget({
                billingTeamName: null,
                spendCap,
                payer: "Each user",
              })
            : summarizeBudget({
                billingTeamName:
                  billingTeamId === (oauthClient.billingTeam?.id ?? null)
                    ? (oauthClient.billingTeam?.name ?? null)
                    : billingTeamId
                      ? "A team"
                      : null,
                spendCap,
              }),
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
        // Unchanged billing is left out, so saving other edits never needs
        // the permission to manage limits.
        await onSubmit(oauthClient.id, {
          name: name.trim(),
          grantType: oauthClient.grantType,
          ...(isAuthorizationCode
            ? { redirectUris }
            : {
                providerApiKeys: providerApiKeyIds,
                ...(billingTeamId !== (oauthClient.billingTeam?.id ?? null) && {
                  billingTeamId,
                }),
              }),
          ...(capChanged && { spendCap }),
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
              ? "LLM Proxy · for its users"
              : "LLM Proxy · as itself"
          }
          clientId={oauthClient.clientId}
          onRotateSecret={
            onRotateSecret ? () => onRotateSecret(oauthClient) : undefined
          }
        />
        {isAuthorizationCode && (
          <RedirectUrisField
            value={redirectUrisText}
            onChange={setRedirectUrisText}
          />
        )}
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>

      {!isAuthorizationCode && (
        <div hidden={activeSection !== "keys"} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <span>
              Requests to a provider go through the key picked for it. Other
              providers are not reachable with this client.
            </span>
          </p>
          <ProviderKeyBoxes
            value={providerApiKeyIds}
            onChange={setProviderApiKeyIds}
            providerApiKeys={providerApiKeys as LlmProviderApiKeyResponse[]}
          />
        </div>
      )}

      <div hidden={activeSection !== "budget"} className="space-y-4">
        {isAuthorizationCode && <UsersPayNotice />}
        <BudgetFields
          subject="client"
          idPrefix="edit-oauth-client"
          showBillingTeam={!isAuthorizationCode}
          billingTeamId={billingTeamId}
          onBillingTeamIdChange={setBillingTeamId}
          spendCap={spendCap}
          onSpendCapChange={setSpendCap}
          capLocked={!!oauthClient.spendCap && !canManageLimits}
          currentUsage={oauthClient.spendCap?.currentUsage ?? null}
        />
      </div>

      {/* Kept mounted on every tab, so Save Changes commits its edits. */}
      <div hidden={activeSection !== "permissions"}>
        {/* SPDX-SnippetBegin
              SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
        <ResourceAccessSection
          resource="llmOauthClient"
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

type Section = "general" | "keys" | "budget" | "permissions";
