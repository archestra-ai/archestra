"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { AgentIcon } from "@/components/agent-icon";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { ClientRedirect } from "@/components/client-redirect";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useServiceAccount,
  useUpdateServiceAccount,
} from "@/lib/service-account.query";
import {
  DEFAULT_SERVICE_ACCOUNT_FORM_VALUES,
  ServiceAccountFormSections,
  type ServiceAccountFormValues,
} from "./service-account-form";

/**
 * The create page's form, filled in with the account. Its credentials and
 * permissions are managed on its own page, so someone without update access
 * lands there instead.
 */
export function ServiceAccountEditPage({
  serviceAccountId,
}: {
  serviceAccountId: string;
}) {
  const router = useRouter();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const {
    data: account,
    isPending,
    isLoadingError,
    refetch,
  } = useServiceAccount(serviceAccountId);
  const { data: canUpdate, isPending: isCheckingUpdate } = useHasPermissions(
    { serviceAccount: ["update"] },
    serviceAccountId,
  );
  const updateMutation = useUpdateServiceAccount();
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const detailHref = `/settings/service-accounts/${serviceAccountId}`;
  const form = useForm<ServiceAccountFormValues>({
    defaultValues: DEFAULT_SERVICE_ACCOUNT_FORM_VALUES,
    values: account
      ? {
          name: account.name,
          description: account.description ?? "",
          icon: account.icon ?? null,
          role: account.role,
          teamId: account.teamId,
          labels: account.labels,
        }
      : undefined,
    // A background refetch must not wipe edits in progress.
    resetOptions: { keepDirtyValues: true },
  });
  const isDirty = form.formState.isDirty;

  useEffect(() => {
    setPageHeader({
      title: account ? (
        <span className="block min-w-0 truncate">Edit {account.name}</span>
      ) : (
        "Edit service account"
      ),
      documentTitle: account ? `Edit ${account.name}` : "Edit service account",
      icon: account ? <AgentIcon icon={account.icon} size={24} /> : undefined,
      backLink: (
        <PageBackLink href={detailHref}>Back to service account</PageBackLink>
      ),
    });
    return () => setPageHeader(null);
  }, [setPageHeader, account, detailHref]);

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
      router.push(next ?? detailHref);
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

  const submit = form.handleSubmit(async (values) => {
    if (!account) return;
    const labels = labelsRef.current?.saveUnsavedLabel() ?? values.labels;
    const saved = await updateMutation
      .mutateAsync({
        id: account.id,
        body: {
          name: values.name.trim(),
          description: values.description.trim() || null,
          icon: values.icon,
          role: values.role,
          // Only when changed: linking is checked against team admin rights,
          // which someone editing just the name may not hold.
          ...(values.teamId !== account.teamId
            ? { teamId: values.teamId }
            : {}),
          labels,
        },
      })
      // A refused role is explained beside the roles; anything else toasts.
      .catch(() => null);
    if (!saved) return;
    // The saved values are the new baseline, so leaving no longer asks.
    form.reset({ ...values, labels });
    router.push(detailHref);
  });

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this service account"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending || isCheckingUpdate) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!account) {
    return (
      <p className="text-sm text-muted-foreground">
        This service account doesn't exist, or was deleted.
      </p>
    );
  }
  if (!canUpdate) {
    return <ClientRedirect to={detailHref} />;
  }
  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        <ServiceAccountFormSections
          form={form}
          labelsRef={labelsRef}
          error={updateMutation.error}
          onRoleChange={() => updateMutation.reset()}
        />
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
              onClick={() => requestNavigate(detailHref)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={
                !isDirty ||
                !form.watch("name").trim() ||
                updateMutation.isPending
              }
            >
              <span>
                {updateMutation.isPending ? "Saving..." : "Save changes"}
              </span>
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
