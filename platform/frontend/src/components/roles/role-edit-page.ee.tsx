// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import {
  useSetSettingsAction,
  useSetSettingsPageHeader,
} from "@/app/settings/layout";
import { ClientRedirect } from "@/components/client-redirect";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { RoleTypeIcon } from "@/components/role-type-icon";
import { SettingsSectionGroup } from "@/components/settings-section";
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
import { useAllPermissions } from "@/lib/auth/auth.query";
import { useRole, useUpdateRole } from "@/lib/role.query";
import { allPermissionRows, countGranted } from "./permission-list-model.ee";
import {
  type RoleFormValues,
  RoleIdentitySection,
  RolePermissionsSection,
} from "./role-form.ee";

/**
 * A custom role's name, description and permissions on one page. A built-in
 * role cannot be edited, so its edit URL lands on its detail page.
 */
export function RoleEditPage({ roleId }: { roleId: string }) {
  const router = useRouter();
  const setPageHeader = useSetSettingsPageHeader();
  const setActionButton = useSetSettingsAction();
  const { data: role, isPending, isLoadingError, refetch } = useRole(roleId);
  const { data: grantable } = useAllPermissions();
  const updateMutation = useUpdateRole();
  const detailHref = `/settings/roles/${roleId}`;
  const form = useForm<RoleFormValues>({
    defaultValues: { name: "", description: "", permission: {} },
    values: role
      ? {
          name: role.name,
          description: role.description ?? "",
          permission: role.permission,
        }
      : undefined,
  });
  const isDirty = form.formState.isDirty;
  const selected = countGranted(form.watch("permission"), allPermissionRows);

  useEffect(() => {
    setPageHeader({
      title: role ? (
        <span className="block min-w-0 truncate">
          Edit <span className="capitalize">{role.name}</span>
        </span>
      ) : (
        "Edit role"
      ),
      documentTitle: role ? `Edit ${role.name}` : "Edit role",
      icon: role ? <RoleTypeIcon predefined={role.predefined} /> : undefined,
      backLink: <PageBackLink href={detailHref}>Back to role</PageBackLink>,
    });
    return () => setPageHeader(null);
  }, [setPageHeader, role, detailHref]);

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

  const submit = form.handleSubmit((values) => {
    if (!role) return;
    updateMutation.mutate(
      {
        roleId: role.id,
        data: {
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          permission: values.permission,
        },
      } as Parameters<typeof updateMutation.mutate>[0],
      {
        onSuccess: () => {
          // The saved values are the new baseline, so leaving no longer asks.
          form.reset(values);
          router.push(detailHref);
        },
      },
    );
  });

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load the role"
        onRetry={() => refetch()}
      />
    );
  }
  if (isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!role) {
    return (
      <p className="text-sm text-muted-foreground">
        This role doesn't exist, or was deleted.
      </p>
    );
  }
  if (role.predefined) {
    return <ClientRedirect to={detailHref} />;
  }
  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        <SettingsSectionGroup>
          <RoleIdentitySection form={form} />
          <RolePermissionsSection form={form} grantable={grantable ?? {}} />
        </SettingsSectionGroup>
        <WizardFooter>
          <span className="text-xs text-muted-foreground">
            {isDirty ? (
              <span>Unsaved changes · {selected} permissions selected</span>
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
              disabled={!isDirty || selected === 0 || updateMutation.isPending}
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
