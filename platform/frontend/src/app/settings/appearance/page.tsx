"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useOnUnmount } from "@/lib/lifecycle.hook";
import {
  organizationKeys,
  useUpdateOrganization,
} from "@/lib/organization.query";
import { useOrgTheme } from "@/lib/theme.hook";
import { FontSelector } from "./_components/font-selector";
import { LightDarkToggle } from "./_components/light-dark-toggle";
import { LogoUpload } from "./_components/logo-upload";
import { ThemeSelector } from "./_components/theme-selector";

export default function AppearanceSettingsPage() {
  const updateAppearanceSettingsMutation = useUpdateOrganization(
    "Appearance settings updated",
    "Failed to update appearance settings",
  );
  const [hasChanges, setHasChanges] = useState(false);
  const queryClient = useQueryClient();

  const orgTheme = useOrgTheme();
  const {
    currentUITheme,
    currentUIFont,
    themeFromBackend,
    fontFromBackend,
    setPreviewTheme,
    setPreviewFont,
    applyThemeOnUI,
    applyFontOnUI,
    saveTheme,
    saveFont,
    logo,
    DEFAULT_THEME,
    DEFAULT_FONT,
    isLoadingAppearance,
  } = orgTheme ?? {
    currentUITheme: "modern-minimal" as const,
    currentUIFont: "lato" as const,
    DEFAULT_THEME: "modern-minimal" as const,
    DEFAULT_FONT: "lato" as const,
  };

  useOnUnmount(() => {
    if (themeFromBackend) {
      applyThemeOnUI?.(themeFromBackend);
      setPreviewTheme?.(themeFromBackend);
    }
    if (fontFromBackend) {
      applyFontOnUI?.(fontFromBackend);
      setPreviewFont?.(fontFromBackend);
    }
  });

  const handleLogoChange = useCallback(() => {
    // Invalidate organization details query to refresh the logo
    queryClient.invalidateQueries({ queryKey: organizationKeys.details() });
  }, [queryClient]);

  if (isLoadingAppearance) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
        <div className="flex items-center justify-center h-64">
          <p className="text-lg text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <div className="space-y-6">
        <LightDarkToggle />
        <LogoUpload currentLogo={logo} onLogoChange={handleLogoChange} />
        <ThemeSelector
          selectedTheme={currentUITheme}
          onThemeSelect={(themeId) => {
            setPreviewTheme?.(themeId);
            setHasChanges(
              themeId !== themeFromBackend || currentUIFont !== fontFromBackend,
            );
          }}
        />
        <FontSelector
          selectedFont={currentUIFont || DEFAULT_FONT}
          onFontSelect={(fontId) => {
            setPreviewFont?.(fontId);
            setHasChanges(
              currentUITheme !== themeFromBackend || fontId !== fontFromBackend,
            );
          }}
        />
        {hasChanges && (
          <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
            <PermissionButton
              permissions={{ organization: ["update"] }}
              onClick={() => {
                saveTheme?.(currentUITheme || DEFAULT_THEME);
                saveFont?.(currentUIFont || DEFAULT_FONT);
                setHasChanges(false);
              }}
              disabled={updateAppearanceSettingsMutation.isPending}
            >
              Save
            </PermissionButton>
            <Button
              variant="outline"
              onClick={() => {
                setPreviewTheme?.(themeFromBackend || DEFAULT_THEME);
                setPreviewFont?.(fontFromBackend || DEFAULT_FONT);
                setHasChanges(false);
              }}
              disabled={updateAppearanceSettingsMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
