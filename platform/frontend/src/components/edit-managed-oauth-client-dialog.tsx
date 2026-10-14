"use client";
import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import {
  BudgetFields,
  UsersPayNotice,
} from "@/components/credential-billing/budget-fields";
import { CreatedByHeader } from "@/components/credential-billing/created-by-header";
import {
  OAuthClientAccessFields,
  type OAuthClientFormValues,
  OAuthClientScopePicker,
  oauthCapabilities,
  oauthClientFormBody,
  oauthClientFormReady,
  setOauthClientScopes,
} from "@/components/oauth-client/configuration-fields";
import { OAuthClientIdentityFields } from "@/components/oauth-client/identity-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";

type Client = archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];
type Section = "general" | "access" | "budget";
export function EditManagedOAuthClientDialog({
  oauthClient,
  onOpenChange,
  gateways,
  providerApiKeys,
  onSubmit,
  onRotateSecret,
  isSubmitting,
}: {
  oauthClient: Client | null;
  onOpenChange: (open: boolean) => void;
  gateways: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (
    id: string,
    body: archestraApiTypes.UpdateOauthClientData["body"],
  ) => Promise<void>;
  onRotateSecret?: (client: Client) => void;
  isSubmitting: boolean;
}) {
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const form = useForm<OAuthClientFormValues>();
  const [section, setSection] = useState<Section>("general");
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const permissionSave = useRef<(() => Promise<void>) | null>(null);
  const registerSave = useCallback((save: (() => Promise<void>) | null) => {
    permissionSave.current = save;
  }, []);
  const { data: canManageLimits } = useHasPermissions({
    llmLimit: ["update", "delete"],
  });
  useEffect(() => {
    if (oauthClient) {
      setSection("general");
      setPermissionsDirty(false);
      form.reset({
        serviceAccountId: oauthClient.serviceAccountId ?? null,
        name: oauthClient.name,
        grantType: oauthClient.grantType,
        scopes: oauthClient.scopes,
        allowedGatewayIds: oauthClient.allowedGatewayIds,
        providerApiKeys: oauthClient.providerApiKeys.map(
          ({ provider, providerApiKeyId }) => ({ provider, providerApiKeyId }),
        ),
        redirectUrisText: oauthClient.redirectUris.join("\n"),
        labels: oauthClient.labels,
        billingTeamId: oauthClient.billingTeam?.id ?? null,
        spendCap: oauthClient.spendCap
          ? {
              limitValue: oauthClient.spendCap.limitValue,
              cleanupInterval: oauthClient.spendCap.cleanupInterval,
            }
          : null,
      });
    }
  }, [oauthClient, form]);
  const values = form.watch();
  if (!oauthClient || !values.scopes) return null;
  const llm = values.scopes.includes("llm:proxy");
  return (
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={oauthClient.name}
      description="Choose what this application can reach with one credential set."
      sidebarLabel={values.name || "OAuth client"}
      sidebarDescription="OAuth client"
      sidebarIcon={<KeyRound className="size-4" />}
      activeSection={section}
      onActiveSectionChange={setSection}
      navItems={[
        {
          id: "general",
          label: "General",
          status:
            oauthClient.grantType === "authorization_code"
              ? "For its users"
              : "As itself",
        },
        {
          id: "access",
          label: "Access",
          status: oauthCapabilities
            .filter((item) => values.scopes.includes(item.scope))
            .map((item) => item.label)
            .join(", "),
        },
        ...(llm
          ? [
              {
                id: "budget" as const,
                label: "Budget",
                status: values.spendCap ? "Spend cap set" : "No spend cap",
              },
            ]
          : []),
      ]}
      isDirty={form.formState.isDirty || permissionsDirty}
      headerExtra={
        <CreatedByHeader
          createdBy={oauthClient.createdBy}
          createdAt={oauthClient.createdAt}
        />
      }
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={!oauthClientFormReady(values) || isSubmitting}
          >
            <span>Save Changes</span>
          </Button>
        </>
      }
      onSubmit={form.handleSubmit(async () => {
        const { initialGrants: _initial, ...body } = oauthClientFormBody(
          {
            ...values,
            labels: labelsRef.current?.saveUnsavedLabel() ?? values.labels,
          },
          gateways,
        );
        if (!form.formState.dirtyFields.serviceAccountId)
          delete body.serviceAccountId;
        // Saving another field does not require permission to change billing.
        if (!form.formState.dirtyFields.spendCap) delete body.spendCap;
        if (!form.formState.dirtyFields.billingTeamId)
          delete body.billingTeamId;
        await permissionSave.current?.();
        await onSubmit(oauthClient.id, body);
      })}
    >
      <div hidden={section !== "general"} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="edit-oauth-name">Name</Label>
          <Input
            id="edit-oauth-name"
            autoComplete="off"
            data-1p-ignore
            {...form.register("name")}
          />
        </div>
        <OAuthClientIdentityFields
          kindLabel={
            oauthClient.grantType === "authorization_code"
              ? "For its users"
              : "As itself"
          }
          clientId={oauthClient.clientId}
          onRotateSecret={
            onRotateSecret ? () => onRotateSecret(oauthClient) : undefined
          }
        />
        {/* SPDX-SnippetBegin
          SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
        <ResourceAccessSection
          resource="oauthClient"
          id={oauthClient.id}
          registerSave={registerSave}
          onDirtyChange={setPermissionsDirty}
        />
        {/* SPDX-SnippetEnd */}
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={values.labels ?? []}
          onLabelsChange={(labels) =>
            form.setValue("labels", labels, { shouldDirty: true })
          }
        />
      </div>
      <div hidden={section !== "access"} className="space-y-5">
        <OAuthClientScopePicker
          value={values.scopes}
          onChange={(scopes) => setOauthClientScopes(form, scopes, gateways)}
        />
        <OAuthClientAccessFields
          form={form}
          gateways={gateways}
          providerApiKeys={providerApiKeys}
        />
      </div>
      {llm && (
        <div hidden={section !== "budget"} className="space-y-4">
          {values.grantType === "authorization_code" && <UsersPayNotice />}
          <BudgetFields
            subject="client"
            idPrefix="edit-oauth-budget"
            showBillingTeam={values.grantType !== "authorization_code"}
            billingTeamId={values.billingTeamId ?? null}
            onBillingTeamIdChange={(value) =>
              form.setValue("billingTeamId", value, { shouldDirty: true })
            }
            spendCap={values.spendCap ?? null}
            onSpendCapChange={(value) =>
              form.setValue("spendCap", value, { shouldDirty: true })
            }
            capLocked={!!oauthClient.spendCap && !canManageLimits}
            currentUsage={oauthClient.spendCap?.currentUsage ?? null}
          />
        </div>
      )}
    </TabbedDialogShell>
  );
}
