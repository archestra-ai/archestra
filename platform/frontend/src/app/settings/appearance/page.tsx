"use client";

import { DEFAULT_APP_DESCRIPTION, DEFAULT_APP_NAME } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { LoadingState } from "@/components/loading";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOnUnmount } from "@/lib/hooks/use-lifecycle";
import {
  organizationKeys,
  useOrganization,
  useUpdateAppearanceSettings,
} from "@/lib/organization.query";
import {
  useCreateSiteNotification,
  useSiteNotification,
  useUpdateSiteNotification,
} from "@/lib/site-notification.query";
import { useOrgTheme } from "@/lib/theme.hook";
import { ChatLinksEditor } from "./_components/chat-links-editor";
import {
  type ChatLinkEditorValue,
  sanitizeChatLinks,
  validateChatLink,
} from "./_components/chat-links-editor.utils";
import { ChatPlaceholdersEditor } from "./_components/chat-placeholders-editor";
import { FaviconUpload } from "./_components/favicon-upload";
import { LogosSection } from "./_components/logos-section";
import { OnboardingWizardEditor } from "./_components/onboarding-wizards-editor";
import {
  type OnboardingWizardValue,
  sanitizeOnboardingWizard,
  validateOnboardingWizard,
} from "./_components/onboarding-wizards-editor.utils";
import { SiteNotificationsSection } from "./_components/site-notifications-section";
import { ThemeSelector } from "./_components/theme-selector";

export default function AppearanceSettingsPage() {
  const updateMutation = useUpdateAppearanceSettings(
    "Appearance settings updated",
    "Failed to update appearance settings",
  );
  const [hasThemeChanges, setHasThemeChanges] = useState(false);
  const queryClient = useQueryClient();
  const { data: organization } = useOrganization();

  const orgTheme = useOrgTheme();
  const {
    currentUITheme,
    themeFromBackend,
    setPreviewTheme,
    applyThemeOnUI,
    saveAppearance,
    logo,
    logoDark,
    DEFAULT_THEME,
    isLoadingAppearance,
  } = orgTheme ?? {
    currentUITheme: "caffeine" as const,
    DEFAULT_THEME: "caffeine" as const,
  };

  useOnUnmount(() => {
    if (themeFromBackend) {
      applyThemeOnUI?.(themeFromBackend);
      setPreviewTheme?.(themeFromBackend);
    }
  });

  const handleLogoChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: organizationKeys.details() });
  }, [queryClient]);

  // Field state for non-theme settings
  const [appName, setAppName] = useState<string | null>(null);
  const [ogDescription, setOgDescription] = useState<string | null>(null);
  const [footerText, setFooterText] = useState<string | null>(null);
  const [chatLinks, setChatLinks] = useState<ChatLinkEditorValue[] | null>(
    null,
  );
  const [showChatLinkValidationErrors, setShowChatLinkValidationErrors] =
    useState(false);
  // `undefined` = untouched (fall back to server value), `null` = explicitly cleared
  const [onboardingWizardDraft, setOnboardingWizardDraft] = useState<
    OnboardingWizardValue | null | undefined
  >(undefined);
  const [
    showOnboardingWizardValidationErrors,
    setShowOnboardingWizardValidationErrors,
  ] = useState(false);
  const [chatErrorSupportMessage, setChatErrorSupportMessage] = useState<
    string | null
  >(null);
  const [slimChatErrorUi, setSlimChatErrorUi] = useState<boolean | null>(null);
  const [chatPlaceholders, setChatPlaceholders] = useState<string[] | null>(
    null,
  );
  const [animateChatPlaceholders, setAnimateChatPlaceholders] = useState<
    boolean | null
  >(null);

  // Site-notification draft state is lifted here so the section's changes
  // save through the same floating save bar as the rest of the page.
  const { data: canReadNotifications } = useHasPermissions({
    siteNotification: ["read"],
  });
  const { data: notification } = useSiteNotification({
    enabled: canReadNotifications === true,
  });
  const createNotificationMutation = useCreateSiteNotification();
  const updateNotificationMutation = useUpdateSiteNotification();
  const [notificationContent, setNotificationContent] = useState<string | null>(
    null,
  );
  // `undefined` = untouched (fall back to server value), `null` = no expiration
  const [notificationExpiresAt, setNotificationExpiresAt] = useState<
    Date | null | undefined
  >(undefined);

  // Derived values (use local state if changed, otherwise org data)
  const effectiveAppName = appName ?? organization?.appName ?? "";
  const effectiveOgDescription =
    ogDescription ?? organization?.ogDescription ?? "";
  const effectiveFooterText = footerText ?? organization?.footerText ?? "";
  const effectiveChatLinks = chatLinks ?? organization?.chatLinks ?? [];
  const effectiveOnboardingWizard: OnboardingWizardValue | null =
    onboardingWizardDraft !== undefined
      ? onboardingWizardDraft
      : organization?.onboardingWizard
        ? {
            label: organization.onboardingWizard.label,
            pages: organization.onboardingWizard.pages.map((page) => ({
              image: page.image ?? null,
              content: page.content,
            })),
          }
        : null;
  const effectiveChatErrorSupportMessage =
    chatErrorSupportMessage ?? organization?.chatErrorSupportMessage ?? "";
  const effectiveSlimChatErrorUi =
    slimChatErrorUi ?? organization?.slimChatErrorUi ?? false;
  const effectiveChatPlaceholders =
    chatPlaceholders ?? organization?.chatPlaceholders ?? [];
  const effectiveAnimateChatPlaceholders =
    animateChatPlaceholders ?? organization?.animateChatPlaceholders ?? true;
  const effectiveNotificationContent =
    notificationContent ?? notification?.content ?? "";
  const effectiveNotificationExpiresAt =
    notificationExpiresAt !== undefined
      ? notificationExpiresAt
      : notification?.expiresAt
        ? new Date(notification.expiresAt)
        : null;
  const trimmedNotificationContent = effectiveNotificationContent.trim();
  const liveChatLinkValidationErrors = effectiveChatLinks.map((link) =>
    validateChatLink(link),
  );
  const saveChatLinkValidationErrors = effectiveChatLinks.map((link) =>
    validateChatLink(link, { requireComplete: true }),
  );
  const hasLiveChatLinkValidationErrors = liveChatLinkValidationErrors.some(
    (errors) => !!errors.label || !!errors.url,
  );
  const displayedChatLinkValidationErrors = showChatLinkValidationErrors
    ? saveChatLinkValidationErrors
    : liveChatLinkValidationErrors;
  const hasChatLinkValidationErrors = saveChatLinkValidationErrors.some(
    (errors) => !!errors.label || !!errors.url,
  );

  const liveOnboardingWizardValidationError = validateOnboardingWizard(
    effectiveOnboardingWizard,
  );
  const saveOnboardingWizardValidationError = validateOnboardingWizard(
    effectiveOnboardingWizard,
    { requireComplete: true },
  );
  const hasLiveOnboardingWizardValidationError =
    !!liveOnboardingWizardValidationError.label ||
    !!liveOnboardingWizardValidationError.pages;
  const displayedOnboardingWizardValidationError =
    showOnboardingWizardValidationErrors
      ? saveOnboardingWizardValidationError
      : liveOnboardingWizardValidationError;
  const hasOnboardingWizardValidationError =
    !!saveOnboardingWizardValidationError.label ||
    !!saveOnboardingWizardValidationError.pages;

  const hasFieldChanges =
    appName !== null ||
    ogDescription !== null ||
    footerText !== null ||
    chatLinks !== null ||
    onboardingWizardDraft !== undefined ||
    chatErrorSupportMessage !== null ||
    slimChatErrorUi !== null ||
    chatPlaceholders !== null ||
    animateChatPlaceholders !== null;
  const hasNotificationChanges =
    notificationContent !== null || notificationExpiresAt !== undefined;
  // A dirty notification without content can't be saved (deleting removes a
  // notification instead), so block the save bar until content is present.
  const hasNotificationValidationError =
    hasNotificationChanges && !trimmedNotificationContent;

  const resetNotificationDraft = useCallback(() => {
    setNotificationContent(null);
    setNotificationExpiresAt(undefined);
  }, []);

  const handleSaveFields = async () => {
    const data: Record<string, unknown> = {};
    if (appName !== null) data.appName = appName || null;
    if (ogDescription !== null) data.ogDescription = ogDescription || null;
    if (footerText !== null) data.footerText = footerText || null;
    if (chatLinks !== null) {
      const sanitizedChatLinks = sanitizeChatLinks(chatLinks);
      data.chatLinks =
        sanitizedChatLinks.length > 0 ? sanitizedChatLinks : null;
    }
    if (onboardingWizardDraft !== undefined) {
      data.onboardingWizard = sanitizeOnboardingWizard(onboardingWizardDraft);
    }
    if (chatErrorSupportMessage !== null) {
      data.chatErrorSupportMessage = chatErrorSupportMessage.trim() || null;
    }
    if (slimChatErrorUi !== null) {
      data.slimChatErrorUi = slimChatErrorUi;
    }
    if (chatPlaceholders !== null)
      data.chatPlaceholders =
        chatPlaceholders.length > 0 ? chatPlaceholders : null;
    if (animateChatPlaceholders !== null) {
      data.animateChatPlaceholders = animateChatPlaceholders;
    }
    const updatedOrganization = await updateMutation.mutateAsync(data);
    if (!updatedOrganization) {
      return;
    }

    // Reset local state after save
    setAppName(null);
    setOgDescription(null);
    setFooterText(null);
    setChatLinks(null);
    setShowChatLinkValidationErrors(false);
    setOnboardingWizardDraft(undefined);
    setShowOnboardingWizardValidationErrors(false);
    setChatErrorSupportMessage(null);
    setSlimChatErrorUi(null);
    setChatPlaceholders(null);
    setAnimateChatPlaceholders(null);
  };

  const handleSaveNotification = async () => {
    if (!trimmedNotificationContent) {
      return;
    }

    if (!notification) {
      await createNotificationMutation.mutateAsync({
        content: trimmedNotificationContent,
        expiresAt: effectiveNotificationExpiresAt?.toISOString(),
      });
    } else {
      await updateNotificationMutation.mutateAsync({
        path: { id: notification.id },
        body: {
          content: trimmedNotificationContent,
          expiresAt: effectiveNotificationExpiresAt?.toISOString() ?? null,
          isActive: true,
        },
      });
    }

    resetNotificationDraft();
  };

  if (isLoadingAppearance) {
    return <LoadingState label="Loading appearance settings…" variant="page" />;
  }

  return (
    <SettingsSectionStack>
      <SmallTeamTierBanner />
      <LogosSection
        currentLogo={logo}
        currentLogoDark={logoDark}
        currentIconLogo={organization?.iconLogo}
        currentIconLogoDark={organization?.iconLogoDark}
        onChange={handleLogoChange}
      />
      <FaviconUpload
        currentFavicon={organization?.favicon}
        onFaviconChange={handleLogoChange}
      />
      <ThemeSelector
        selectedTheme={currentUITheme}
        onThemeSelect={(themeId) => {
          setPreviewTheme?.(themeId);
          setHasThemeChanges(themeId !== themeFromBackend);
        }}
      />

      <SettingsBlock
        title="Branding"
        description="Customize your organization's browser tab title, OpenGraph description, footer text, chat links, and chat placeholders."
      >
        <div className="space-y-5">
          <AppearanceControlRow
            id="appName"
            label="App Name"
            description="Shown in the browser tab title. This also brands the built-in MCP server name and built-in MCP tool names and prefix."
          >
            <Input
              id="appName"
              placeholder={DEFAULT_APP_NAME}
              value={effectiveAppName}
              onChange={(e) => setAppName(e.target.value)}
              maxLength={100}
            />
          </AppearanceControlRow>
          <AppearanceControlRow
            id="ogDescription"
            label="OpenGraph Description"
            description="Used when sharing links to your platform."
          >
            <Textarea
              id="ogDescription"
              placeholder={DEFAULT_APP_DESCRIPTION}
              value={effectiveOgDescription}
              onChange={(e) => setOgDescription(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </AppearanceControlRow>
          <AppearanceControlRow
            id="footerText"
            label="Footer Text"
            description="Custom text shown in the footer alongside the version number."
          >
            <Textarea
              id="footerText"
              placeholder="Leave empty to show version number"
              value={effectiveFooterText}
              onChange={(e) => setFooterText(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </AppearanceControlRow>
          <ChatLinksEditor
            links={effectiveChatLinks}
            validationErrors={displayedChatLinkValidationErrors}
            onChange={setChatLinks}
          />
          <OnboardingWizardEditor
            wizard={effectiveOnboardingWizard}
            validationError={displayedOnboardingWizardValidationError}
            onChange={setOnboardingWizardDraft}
            onPersist={async (sanitized) => {
              const result = await updateMutation.mutateAsync({
                onboardingWizard: sanitized,
              });
              if (!result) return false;
              // Clear the draft so the settings save bar no longer flags
              // onboarding as dirty.
              setOnboardingWizardDraft(undefined);
              setShowOnboardingWizardValidationErrors(false);
              return true;
            }}
          />
          <AppearanceControlRow
            id="chatErrorSupportMessage"
            label="Support Contact Message"
            description="Shown alongside errors in chat. Use this to direct users to your support team."
          >
            <Input
              id="chatErrorSupportMessage"
              placeholder="e.g. Contact support@company.com for assistance and send us the information below"
              value={effectiveChatErrorSupportMessage}
              onChange={(e) => setChatErrorSupportMessage(e.target.value)}
              maxLength={500}
            />
          </AppearanceControlRow>
          <AppearanceControlRow
            id="slimChatErrorUi"
            label="Simplified Chat Error Cards"
            description="Hide provider, model, stack trace, and raw error details in chat. Users will only see the support message or default error text plus correlation IDs."
          >
            <Switch
              id="slimChatErrorUi"
              className="ml-auto"
              checked={effectiveSlimChatErrorUi}
              onCheckedChange={(checked) => setSlimChatErrorUi(checked)}
            />
          </AppearanceControlRow>
          <AppearanceControlRow
            id="animateChatPlaceholders"
            label="Animate Chat Placeholders"
            description="Show the chat placeholder text with a typing animation. Single placeholder entries always stay static."
          >
            <Switch
              id="animateChatPlaceholders"
              className="ml-auto"
              checked={effectiveAnimateChatPlaceholders}
              onCheckedChange={(checked) => setAnimateChatPlaceholders(checked)}
            />
          </AppearanceControlRow>
          <ChatPlaceholdersEditor
            placeholders={effectiveChatPlaceholders}
            onChange={setChatPlaceholders}
          />
        </div>
      </SettingsBlock>

      <SiteNotificationsSection
        content={effectiveNotificationContent}
        expiresAt={effectiveNotificationExpiresAt}
        onContentChange={setNotificationContent}
        onExpiresAtChange={setNotificationExpiresAt}
        onDeleted={resetNotificationDraft}
      />

      {/* Unified save bar for all changes (theme + fields + notification) */}
      <SettingsSaveBar
        hasChanges={
          hasThemeChanges || hasFieldChanges || hasNotificationChanges
        }
        isSaving={
          updateMutation.isPending ||
          createNotificationMutation.isPending ||
          updateNotificationMutation.isPending
        }
        permissions={{ organizationSettings: ["update"] }}
        onSave={async () => {
          if (hasFieldChanges && hasChatLinkValidationErrors) {
            setShowChatLinkValidationErrors(true);
            return;
          }
          if (hasFieldChanges && hasOnboardingWizardValidationError) {
            setShowOnboardingWizardValidationErrors(true);
            return;
          }

          if (hasThemeChanges) {
            await saveAppearance?.(currentUITheme || DEFAULT_THEME);
            setHasThemeChanges(false);
          }
          if (hasFieldChanges) {
            await handleSaveFields();
          }
          if (hasNotificationChanges) {
            await handleSaveNotification();
          }
        }}
        onCancel={() => {
          if (hasThemeChanges) {
            setPreviewTheme?.(themeFromBackend || DEFAULT_THEME);
            setHasThemeChanges(false);
          }
          setAppName(null);
          setOgDescription(null);
          setFooterText(null);
          setChatLinks(null);
          setShowChatLinkValidationErrors(false);
          setOnboardingWizardDraft(undefined);
          setShowOnboardingWizardValidationErrors(false);
          setChatErrorSupportMessage(null);
          setSlimChatErrorUi(null);
          setChatPlaceholders(null);
          setAnimateChatPlaceholders(null);
          resetNotificationDraft();
        }}
        disabledSave={
          hasLiveChatLinkValidationErrors ||
          hasLiveOnboardingWizardValidationError ||
          hasNotificationValidationError
        }
      />
    </SettingsSectionStack>
  );
}

function AppearanceControlRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_20rem] sm:items-start sm:gap-8">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="flex min-w-0 items-start">{children}</div>
    </div>
  );
}
