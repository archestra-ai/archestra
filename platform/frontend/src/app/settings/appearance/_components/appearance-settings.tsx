"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Info } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import {
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateAppearanceSettings,
} from "@/lib/organization.query";
import {
  useCreateSiteNotification,
  useDeleteSiteNotification,
  useSiteNotification,
  useUpdateSiteNotification,
} from "@/lib/site-notification.query";
import { applyThemeOnUI } from "@/lib/theme.hook";
import { useSetSettingsPageHeader } from "../../layout";
import { AppearanceEditor } from "./appearance-editor";
import {
  type AppearanceDraft,
  appearanceDefaults,
  appearancePatch,
} from "./appearance-form";
import { AppearancePagesRow } from "./appearance-navigation";
import { APPEARANCE_PAGES, type AppearancePageId } from "./appearance-pages";
import { validateChatLink } from "./chat-links-editor.utils";
import { validateOnboardingWizard } from "./onboarding-wizards-editor.utils";

type Organization = archestraApiTypes.GetOrganizationResponses["200"];
type Notification =
  archestraApiTypes.GetSiteNotificationSettingsResponses["200"];

export function AppearanceSettings() {
  const pathname = usePathname();
  const page =
    APPEARANCE_PAGES.find((item) => pathname.endsWith(`/${item.id}`)) ??
    APPEARANCE_PAGES[0];
  const setPageHeader = useSetSettingsPageHeader();
  useEffect(() => {
    setPageHeader({ title: "Appearance", description: page.description });
    return () => setPageHeader(null);
  }, [page, setPageHeader]);
  const { data: canRead } = useHasPermissions({
    organizationSettings: ["read"],
  });
  const { data: canEdit } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const organization = useOrganization(canRead === true);
  const notification = useSiteNotification({ enabled: canRead === true });
  if (canRead === false)
    return (
      <InlineNotice variant="neutral">
        <Info />
        <InlineNoticeText>
          You do not have permission to read appearance settings.
        </InlineNoticeText>
      </InlineNotice>
    );
  const loadError = organization.isError || notification.isError;
  const retry = () => {
    void organization.refetch();
    void notification.refetch();
  };
  if (loadError && (!organization.data || notification.data === undefined))
    return (
      <QueryLoadError
        title="Could not load appearance settings"
        onRetry={retry}
      />
    );
  if (canRead === undefined || !organization.data || notification.isPending)
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  return (
    <>
      {loadError && (
        <QueryLoadError
          title="Could not refresh appearance settings"
          onRetry={retry}
        />
      )}
      <AppearanceForm
        organization={organization.data}
        notification={notification.data}
        canEdit={canEdit === true}
        pageId={page.id}
      />
    </>
  );
}

function AppearanceForm({
  organization,
  notification,
  canEdit,
  pageId,
}: {
  organization: Organization;
  notification: Notification | undefined;
  canEdit: boolean;
  pageId: AppearancePageId;
}) {
  const defaults = useMemo(
    () => appearanceDefaults(organization, notification),
    [organization, notification],
  );
  const form = useForm<AppearanceDraft>({ defaultValues: defaults });
  const { dirtyFields, isDirty } = form.formState;
  const router = useRouter();
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  // Refetches refresh untouched fields. A save resets its own snapshot after
  // every mutation succeeds, so cache updates must not race that reset.
  useEffect(() => {
    if (!saving)
      form.reset(defaults, { keepDirtyValues: true, keepDirty: true });
  }, [defaults, form, saving]);
  const update = useUpdateAppearanceSettings(
    "Appearance settings updated",
    "Failed to update appearance settings",
  );
  const createNotification = useCreateSiteNotification();
  const updateNotification = useUpdateSiteNotification();
  const deleteNotification = useDeleteSiteNotification();
  const page =
    APPEARANCE_PAGES.find((item) => item.id === pageId) ?? APPEARANCE_PAGES[0];
  // Preview the draft palette in this browser while editing. Cancel resets the
  // draft back to the saved palette; leaving Appearance restores it too.
  const draftTheme = form.watch("theme");
  const savedTheme = useRef(organization.theme);
  savedTheme.current = organization.theme;
  useEffect(() => applyThemeOnUI(draftTheme), [draftTheme]);
  useEffect(() => () => applyThemeOnUI(savedTheme.current), []);

  const save = async () => {
    if (!canEdit || saving) return;
    const current = form.getValues();
    const invalidLinks = current.chatLinks.some((link) => {
      const error = validateChatLink(link, { requireComplete: true });
      return !!error.label || !!error.url;
    });
    const wizardError = validateOnboardingWizard(current.onboardingWizard, {
      requireComplete: true,
    });
    if (invalidLinks || wizardError.label || wizardError.pages) {
      setShowErrors(true);
      router.push(`/settings/appearance/${invalidLinks ? "chat" : "other"}`);
      return;
    }
    const patch = appearancePatch(current, dirtyFields);
    const notificationChanged = !!(
      dirtyFields.notificationContent ||
      dirtyFields.notificationExpiresAt ||
      dirtyFields.notificationDeleted
    );
    setSaving(true);
    try {
      let savedOrganization = organization;
      let savedNotification = notification;
      if (Object.keys(patch).length) {
        const result = await update.mutateAsync(patch);
        if (!result) return;
        savedOrganization = result;
      }
      if (notificationChanged) {
        if (current.notificationDeleted) {
          if (
            notification &&
            !(await deleteNotification.mutateAsync({
              path: { id: notification.id },
            }))
          )
            return;
          savedNotification = null;
        } else {
          const content = current.notificationContent.trim();
          if (!content) return;
          const result = notification
            ? await updateNotification.mutateAsync({
                path: { id: notification.id },
                body: {
                  content,
                  expiresAt:
                    current.notificationExpiresAt?.toISOString() ?? null,
                  isActive: true,
                },
              })
            : await createNotification.mutateAsync({
                content,
                expiresAt: current.notificationExpiresAt?.toISOString(),
              });
          if (!result) return;
          savedNotification = result;
        }
      }
      form.reset(appearanceDefaults(savedOrganization, savedNotification));
      setShowErrors(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSectionStack className="min-w-0 space-y-4">
      <SmallTeamTierBanner />
      {!canEdit && (
        <InlineNotice variant="neutral">
          <Info />
          <InlineNoticeText>
            Your role cannot update organization settings.
          </InlineNoticeText>
        </InlineNotice>
      )}
      <AppearancePagesRow />
      <div className="max-w-3xl divide-y">
        {page.sections.map((id, index) => (
          <section key={id} className={index === 0 ? "pb-6" : "py-6"}>
            <AppearanceEditor
              id={id}
              form={form}
              canEdit={canEdit && !saving}
              showErrors={showErrors}
            />
          </section>
        ))}
      </div>
      <SettingsSaveBar
        hasChanges={canEdit && isDirty}
        isSaving={saving}
        permissions={{ organizationSettings: ["update"] }}
        onSave={save}
        onCancel={() => {
          form.reset(appearanceDefaults(organization, notification));
          setShowErrors(false);
        }}
      />
    </SettingsSectionStack>
  );
}
