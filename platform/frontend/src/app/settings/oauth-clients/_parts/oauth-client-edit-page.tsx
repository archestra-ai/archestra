"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { ClientRedirect } from "@/components/client-redirect";
import {
  BudgetFields,
  UsersPayNotice,
} from "@/components/credential-billing/budget-fields";
import { IdentityFields } from "@/components/identity-fields";
import {
  OAuthClientAccessFields,
  type OAuthClientFormValues,
  OAuthClientScopePicker,
  oauthClientFormReady,
  oauthClientFormValuesFrom,
  oauthClientUpdateBody,
  spendCapInvalidHandler,
  useOauthClientScopeChange,
} from "@/components/oauth-client/configuration-fields";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useOauthClient,
  useUpdateOauthClient,
} from "@/lib/oauth-clients.query";

/**
 * An OAuth client's configuration as a page. Opened from the list (`?from=
 * list`), its back link, Cancel and Save return to the list; opened from the
 * client's page, they return there. How it signs in is fixed at creation, and
 * its credentials and permissions are managed on its own page.
 */
export function OAuthClientEditPage({
  oauthClientId,
}: {
  oauthClientId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const {
    data: client,
    isPending,
    isLoadingError,
    refetch,
  } = useOauthClient(oauthClientId);
  const { data: canUpdate, isPending: isCheckingUpdate } = useHasPermissions(
    { oauthClient: ["update"] },
    oauthClientId,
  );
  const { data: canManageLimits } = useHasPermissions({
    llmLimit: ["update", "delete"],
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const update = useUpdateOauthClient();
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const detailHref = `/settings/oauth-clients/${oauthClientId}`;
  const fromList = searchParams.get("from") === "list";
  const returnHref = fromList ? "/settings/oauth-clients" : detailHref;
  const form = useForm<OAuthClientFormValues>({
    values: client ? oauthClientFormValuesFrom(client) : undefined,
    // A background refetch must not wipe edits in progress.
    resetOptions: { keepDirtyValues: true },
  });
  const values = useWatch({
    control: form.control,
    compute: (current) => current,
  }) as OAuthClientFormValues;
  const isDirty = form.formState.isDirty;
  const selectedTargets = useAgentOptionsByIds({
    ids: (values.allowedGatewayIds ?? []).slice(0, 20),
    enabled: !!client,
  });
  const scopeChange = useOauthClientScopeChange(form);

  useEffect(() => {
    setPageHeader({
      title: client ? (
        <span className="block min-w-0 truncate">Edit {client.name}</span>
      ) : (
        "Edit OAuth client"
      ),
      documentTitle: client ? `Edit ${client.name}` : "Edit OAuth client",
      backLink: (
        <PageBackLink href={returnHref}>
          {fromList ? "Back to OAuth clients" : "Back to OAuth client"}
        </PageBackLink>
      ),
    });
    return () => setPageHeader(null);
  }, [setPageHeader, client, returnHref, fromList]);

  // The list page's Create button would otherwise stay in the header.
  useEffect(() => {
    setActionButton(null);
  }, [setActionButton]);

  // Leaving with unsaved edits asks first: the back link, the sidebar and the
  // Cancel button all go through the same confirmation.
  const pendingHrefRef = useRef<string | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const next = pendingHrefRef.current;
      pendingHrefRef.current = null;
      router.push(next ?? returnHref);
    },
  });
  const requestNavigate = useCallback(
    (next: string) => {
      pendingHrefRef.current = next;
      guard.requestClose();
    },
    [guard],
  );
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });
  useBeforeUnloadWhileDirty(isDirty);

  const submit = form.handleSubmit(async () => {
    if (!client) return;
    const labels = labelsRef.current?.saveUnsavedLabel() ?? values.labels;
    const body = await oauthClientUpdateBody({
      values: { ...values, labels },
      dirtyFields: form.formState.dirtyFields,
    });
    const saved = await update
      .mutateAsync({ id: client.id, body })
      .catch(() => null);
    if (!saved) return;
    // The saved values are the new baseline, so leaving no longer asks.
    form.reset({ ...values, labels });
    router.push(returnHref);
  });

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this OAuth client"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending || isCheckingUpdate || (client && !values.scopes)) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!client) {
    return (
      <p className="text-sm text-muted-foreground">
        This OAuth client doesn't exist, or was deleted.
      </p>
    );
  }
  if (!canUpdate) {
    return <ClientRedirect to={detailHref} />;
  }

  const userMode = client.grantType === "authorization_code";
  const llm = values.scopes.includes("llm:proxy");
  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        <SettingsSectionGroup>
          <SettingsSection
            title="General"
            description={`Signs in ${userMode ? "for its users" : "as itself"}, which is set at creation.`}
          >
            <div className="space-y-5">
              <IdentityFields
                icon={values.icon ?? null}
                onIconChange={(icon) =>
                  form.setValue("icon", icon, { shouldDirty: true })
                }
                fallbackType="app"
                label={<Label htmlFor="edit-oauth-name">Name</Label>}
              >
                <Input
                  id="edit-oauth-name"
                  autoComplete="off"
                  data-1p-ignore
                  {...form.register("name")}
                />
              </IdentityFields>
              {/* Labels only organize the list, so they wait under Advanced
                  unless set, as on a service account's form. */}
              <AdvancedLabelsSection
                collapsible
                defaultOpen={(values.labels ?? []).length > 0}
                attributionSource={llm && !userMode ? "credential" : undefined}
                ref={labelsRef}
                labels={values.labels ?? []}
                onLabelsChange={(labels) =>
                  form.setValue("labels", labels, { shouldDirty: true })
                }
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title="Access"
            description="The APIs the client's tokens reach, and what they reach in each."
          >
            <div className="space-y-5">
              <OAuthClientScopePicker
                value={values.scopes}
                onChange={scopeChange.change}
                disabled={scopeChange.isPending || form.formState.isSubmitting}
              />
              <OAuthClientAccessFields
                form={form}
                gateways={selectedTargets.data ?? []}
                remoteGateways
                providerApiKeys={providerApiKeys}
              />
            </div>
          </SettingsSection>
          {llm && (
            <SettingsSection
              title="Budget"
              description="What the client's LLM spend is charged to, and a cap on it."
            >
              <div className="space-y-4">
                {userMode && <UsersPayNotice />}
                <BudgetFields
                  layout="plain"
                  subject="client"
                  idPrefix="edit-oauth-budget"
                  showBillingTeam={!userMode}
                  billingTeamId={values.billingTeamId ?? null}
                  onBillingTeamIdChange={(value) =>
                    form.setValue("billingTeamId", value, {
                      shouldDirty: true,
                    })
                  }
                  spendCap={values.spendCap ?? null}
                  onSpendCapChange={(value) =>
                    form.setValue("spendCap", value, { shouldDirty: true })
                  }
                  onSpendCapInvalidChange={spendCapInvalidHandler(form)}
                  capLocked={!!client.spendCap && !canManageLimits}
                  currentUsage={client.spendCap?.currentUsage ?? null}
                  estimatedUsage={client.spendCap?.estimatedUsage ?? false}
                />
              </div>
            </SettingsSection>
          )}
        </SettingsSectionGroup>
        <WizardFooter>
          <span className="text-xs text-muted-foreground">
            {isDirty ? (
              <span>Unsaved changes</span>
            ) : (
              <span>No changes yet</span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() => requestNavigate(returnHref)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={
                !isDirty ||
                !oauthClientFormReady(values) ||
                update.isPending ||
                scopeChange.isPending
              }
            >
              <span>{update.isPending ? "Saving..." : "Save changes"}</span>
            </Button>
          </div>
        </WizardFooter>
      </form>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </Form>
  );
}
