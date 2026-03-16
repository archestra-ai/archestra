"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  SettingsCardHeader,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { isValidHelpCenterUrl } from "@/lib/help-center-url";
import { useOnUnmount } from "@/lib/lifecycle.hook";
import {
  organizationKeys,
  useOrganization,
  useUpdateAppearanceSettings,
} from "@/lib/organization.query";
import { useOrgTheme } from "@/lib/theme.hook";
import { ChatPlaceholdersEditor } from "./_components/chat-placeholders-editor";
import { FaviconUpload } from "./_components/favicon-upload";
import { IconLogoUpload } from "./_components/icon-logo-upload";
import { LogoUpload } from "./_components/logo-upload";
import { OrganizationTokenSection } from "./_components/organization-token-section";
import { ThemeSelector } from "./_components/theme-selector";

export default function OrganizationSettingsPage() {
  const updateMutation = useUpdateAppearanceSettings(
    "Organization settings updated",
    "Failed to update organization settings",
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
    currentUITheme: "modern-minimal" as const,
    DEFAULT_THEME: "modern-minimal" as const,
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
  const [helpCenterUrl, setHelpCenterUrl] = useState<string | null>(null);
  const [helpCenterLabel, setHelpCenterLabel] = useState<string | null>(null);
  const [chatPlaceholders, setChatPlaceholders] = useState<string[] | null>(
    null,
  );
  const [animateChatPlaceholders, setAnimateChatPlaceholders] = useState<
    boolean | null
  >(null);
  const [showTwoFactor, setShowTwoFactor] = useState<boolean | null>(null);

  // Derived values (use local state if changed, otherwise org data)
  const effectiveAppName = appName ?? organization?.appName ?? "";
  const effectiveOgDescription =
    ogDescription ?? organization?.ogDescription ?? "";
  const effectiveFooterText = footerText ?? organization?.footerText ?? "";
  const effectiveHelpCenterUrl =
    helpCenterUrl ?? organization?.helpCenterUrl ?? "";
  const effectiveHelpCenterLabel =
    helpCenterLabel ?? organization?.helpCenterLabel ?? "";
  const effectiveChatPlaceholders =
    chatPlaceholders ?? organization?.chatPlaceholders ?? [];
  const effectiveAnimateChatPlaceholders =
    animateChatPlaceholders ?? organization?.animateChatPlaceholders ?? true;
  const effectiveShowTwoFactor =
    showTwoFactor ?? organization?.showTwoFactor ?? false;
  const trimmedHelpCenterUrl = effectiveHelpCenterUrl.trim();
  const helpCenterUrlError =
    trimmedHelpCenterUrl.length > 0 &&
    !isValidHelpCenterUrl(trimmedHelpCenterUrl)
      ? "Enter a valid HTTP or HTTPS URL."
      : null;

  const hasFieldChanges =
    appName !== null ||
    ogDescription !== null ||
    footerText !== null ||
    helpCenterUrl !== null ||
    helpCenterLabel !== null ||
    chatPlaceholders !== null ||
    animateChatPlaceholders !== null ||
    showTwoFactor !== null;

  const handleSaveFields = async () => {
    const data: Record<string, unknown> = {};
    if (appName !== null) data.appName = appName || null;
    if (ogDescription !== null) data.ogDescription = ogDescription || null;
    if (footerText !== null) data.footerText = footerText || null;
    if (helpCenterUrl !== null) {
      data.helpCenterUrl = helpCenterUrl.trim() || null;
    }
    if (helpCenterLabel !== null) {
      data.helpCenterLabel = helpCenterLabel.trim() || null;
    }
    if (chatPlaceholders !== null)
      data.chatPlaceholders =
        chatPlaceholders.length > 0 ? chatPlaceholders : null;
    if (animateChatPlaceholders !== null) {
      data.animateChatPlaceholders = animateChatPlaceholders;
    }
    if (showTwoFactor !== null) data.showTwoFactor = showTwoFactor;

    const updatedOrganization = await updateMutation.mutateAsync(data);
    if (!updatedOrganization) {
      return;
    }

    // Reset local state after save
    setAppName(null);
    setOgDescription(null);
    setFooterText(null);
    setHelpCenterUrl(null);
    setHelpCenterLabel(null);
    setChatPlaceholders(null);
    setAnimateChatPlaceholders(null);
    setShowTwoFactor(null);
  };

  if (isLoadingAppearance) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-lg text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <SettingsSectionStack>
      {/* Appearance Section */}
      <div>
        <h3 className="text-lg font-medium mb-4">Appearance</h3>
        <SettingsSectionStack>
          <LogoUpload
            currentLogo={logo}
            currentLogoDark={logoDark}
            onLogoChange={handleLogoChange}
          />
          <FaviconUpload
            currentFavicon={organization?.favicon}
            onFaviconChange={handleLogoChange}
          />
          <IconLogoUpload
            currentIconLogo={organization?.iconLogo}
            onIconLogoChange={handleLogoChange}
          />
          <ThemeSelector
            selectedTheme={currentUITheme}
            onThemeSelect={(themeId) => {
              setPreviewTheme?.(themeId);
              setHasThemeChanges(themeId !== themeFromBackend);
            }}
          />

          <Card>
            <SettingsCardHeader
              title="Branding"
              description="Customize your organization's browser tab title, OpenGraph description, footer text, and chat placeholders."
            />
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="appName">App Name</Label>
                <Input
                  id="appName"
                  placeholder="Archestra.AI"
                  value={effectiveAppName}
                  onChange={(e) => setAppName(e.target.value)}
                  maxLength={100}
                />
                <p className="text-xs text-muted-foreground">
                  Shown in the browser tab title.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ogDescription">OpenGraph Description</Label>
                <Textarea
                  id="ogDescription"
                  placeholder="Enterprise MCP Platform for AI Agents"
                  value={effectiveOgDescription}
                  onChange={(e) => setOgDescription(e.target.value)}
                  maxLength={500}
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">
                  Used when sharing links to your platform.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="footerText">Footer Text</Label>
                <Textarea
                  id="footerText"
                  placeholder="Leave empty to show version number"
                  value={effectiveFooterText}
                  onChange={(e) => setFooterText(e.target.value)}
                  maxLength={500}
                  rows={2}
                />
                <p className="text-xs text-muted-foreground">
                  Custom text shown in the footer alongside the version number.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="helpCenterUrl">Help Center URL</Label>
                  <Input
                    id="helpCenterUrl"
                    type="url"
                    placeholder="https://support.example.com/help"
                    value={effectiveHelpCenterUrl}
                    onChange={(e) => setHelpCenterUrl(e.target.value)}
                    maxLength={2000}
                    aria-invalid={!!helpCenterUrlError}
                  />
                  <p
                    className={
                      helpCenterUrlError
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {helpCenterUrlError ??
                      "Optional external link shown on the new chat page for help or documentation."}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="helpCenterLabel">Help Center Label</Label>
                  <Input
                    id="helpCenterLabel"
                    placeholder="Help Center"
                    value={effectiveHelpCenterLabel}
                    onChange={(e) => setHelpCenterLabel(e.target.value)}
                    maxLength={80}
                  />
                  <p className="text-xs text-muted-foreground">
                    Optional button text. Defaults to &quot;Help Center&quot;.
                  </p>
                </div>
              </div>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <Label htmlFor="animateChatPlaceholders">
                    Animate Chat Placeholders
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Show the chat placeholder text with a typing animation.
                    Single placeholder entries always stay static.
                  </p>
                </div>
                <Switch
                  id="animateChatPlaceholders"
                  className="mt-0.5"
                  checked={effectiveAnimateChatPlaceholders}
                  onCheckedChange={(checked) =>
                    setAnimateChatPlaceholders(checked)
                  }
                />
              </div>
              <ChatPlaceholdersEditor
                placeholders={effectiveChatPlaceholders}
                onChange={setChatPlaceholders}
              />
            </CardContent>
          </Card>
        </SettingsSectionStack>
      </div>

      {/* Auth Section */}
      <div>
        <h3 className="text-lg font-medium mb-4">Authentication</h3>
        <SettingsSectionStack>
          <Card>
            <SettingsCardHeader
              title="Two-Factor Authentication"
              description="Show 2FA setup to members in their authentication settings."
              action={
                <Switch
                  id="showTwoFactor"
                  checked={effectiveShowTwoFactor}
                  onCheckedChange={(checked) => setShowTwoFactor(checked)}
                />
              }
            />
          </Card>

          <OrganizationTokenSection />
        </SettingsSectionStack>
      </div>

      {/* Unified save bar for all changes (theme + fields) */}
      <SettingsSaveBar
        hasChanges={hasThemeChanges || hasFieldChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={async () => {
          if (hasThemeChanges) {
            await saveAppearance?.(currentUITheme || DEFAULT_THEME);
            setHasThemeChanges(false);
          }
          if (hasFieldChanges && !helpCenterUrlError) {
            await handleSaveFields();
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
          setHelpCenterUrl(null);
          setHelpCenterLabel(null);
          setChatPlaceholders(null);
          setAnimateChatPlaceholders(null);
          setShowTwoFactor(null);
        }}
        disabledSave={!!helpCenterUrlError}
      />
    </SettingsSectionStack>
  );
}
