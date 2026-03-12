"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useOnUnmount } from "@/lib/lifecycle.hook";
import {
  organizationKeys,
  useOrganization,
  useUpdateAppearance,
} from "@/lib/organization.query";
import { useOrgTheme } from "@/lib/theme.hook";
import { ChatPlaceholdersEditor } from "./_components/chat-placeholders-editor";
import { FaviconUpload } from "./_components/favicon-upload";
import { IconLogoUpload } from "./_components/icon-logo-upload";
import { LogoUpload } from "./_components/logo-upload";
import { OrganizationTokenSection } from "./_components/organization-token-section";
import { ThemeSelector } from "./_components/theme-selector";

export default function OrganizationSettingsPage() {
  const updateMutation = useUpdateAppearance(
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
  const [chatPlaceholders, setChatPlaceholders] = useState<string[] | null>(
    null,
  );
  const [showTwoFactor, setShowTwoFactor] = useState<boolean | null>(null);

  // Derived values (use local state if changed, otherwise org data)
  const effectiveAppName = appName ?? organization?.appName ?? "";
  const effectiveOgDescription =
    ogDescription ?? organization?.ogDescription ?? "";
  const effectiveFooterText = footerText ?? organization?.footerText ?? "";
  const effectiveChatPlaceholders =
    chatPlaceholders ?? organization?.chatPlaceholders ?? [];
  const effectiveShowTwoFactor =
    showTwoFactor ?? organization?.showTwoFactor ?? false;

  const hasFieldChanges =
    appName !== null ||
    ogDescription !== null ||
    footerText !== null ||
    chatPlaceholders !== null ||
    showTwoFactor !== null;

  const handleSaveFields = async () => {
    const data: Record<string, unknown> = {};
    if (appName !== null) data.appName = appName || null;
    if (ogDescription !== null) data.ogDescription = ogDescription || null;
    if (footerText !== null) data.footerText = footerText || null;
    if (chatPlaceholders !== null)
      data.chatPlaceholders =
        chatPlaceholders.length > 0 ? chatPlaceholders : null;
    if (showTwoFactor !== null) data.showTwoFactor = showTwoFactor;

    await updateMutation.mutateAsync(data);
    // Reset local state after save
    setAppName(null);
    setOgDescription(null);
    setFooterText(null);
    setChatPlaceholders(null);
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
    <div className="space-y-8">
      {/* Appearance Section */}
      <div>
        <h3 className="text-lg font-medium mb-4">Appearance</h3>
        <div className="space-y-6">
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
            <CardHeader>
              <CardTitle>Branding</CardTitle>
              <CardDescription>
                Customize your organization&apos;s browser tab title, OpenGraph
                description, footer text, and chat placeholders.
              </CardDescription>
            </CardHeader>
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
                  Replaces version display in the footer. Always shows version
                  on settings pages.
                </p>
              </div>
              <ChatPlaceholdersEditor
                placeholders={effectiveChatPlaceholders}
                onChange={setChatPlaceholders}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Auth Section */}
      <div>
        <h3 className="text-lg font-medium mb-4">Authentication</h3>
        <div className="space-y-6">
          <Card>
            <div className="flex items-center justify-between gap-4 px-6 py-4">
              <div>
                <Label
                  htmlFor="showTwoFactor"
                  className="text-base font-semibold"
                >
                  Two-Factor Authentication
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  Show 2FA setup to members in their authentication settings.
                </p>
              </div>
              <Switch
                id="showTwoFactor"
                checked={effectiveShowTwoFactor}
                onCheckedChange={(checked) => setShowTwoFactor(checked)}
              />
            </div>
          </Card>

          <OrganizationTokenSection />
        </div>
      </div>

      {/* Unified save bar for all changes (theme + fields) */}
      {(hasThemeChanges || hasFieldChanges) && (
        <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
          <PermissionButton
            permissions={{ organizationSettings: ["update"] }}
            onClick={async () => {
              if (hasThemeChanges) {
                await saveAppearance?.(currentUITheme || DEFAULT_THEME);
                setHasThemeChanges(false);
              }
              if (hasFieldChanges) {
                await handleSaveFields();
              }
            }}
            disabled={updateMutation.isPending}
          >
            Save Changes
          </PermissionButton>
          <Button
            variant="outline"
            onClick={() => {
              if (hasThemeChanges) {
                setPreviewTheme?.(themeFromBackend || DEFAULT_THEME);
                setHasThemeChanges(false);
              }
              setAppName(null);
              setOgDescription(null);
              setFooterText(null);
              setChatPlaceholders(null);
              setShowTwoFactor(null);
            }}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
