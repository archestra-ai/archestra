"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useOnUnmount } from "@/lib/lifecycle.hook";
import {
  organizationKeys,
  useUpdateOrganizationAppearance,
} from "@/lib/organization.query";
import { useOrgTheme } from "@/lib/theme.hook";
import { LogoUpload } from "./_components/logo-upload";
import { ThemeSelector } from "./_components/theme-selector";

export default function AppearanceSettingsPage() {
  const updateMutation = useUpdateOrganizationAppearance();
  const [hasChanges, setHasChanges] = useState(false);
  const queryClient = useQueryClient();

  const {
    currentUITheme,
    themeFromBackend,
    setPreviewTheme,
    applyThemeOnUI,
    saveTheme,
    logo,
    logoType,
    DEFAULT_THEME,
    isLoadingAppearance,
  } = useOrgTheme();

  useOnUnmount(() => {
    if (themeFromBackend) {
      applyThemeOnUI(themeFromBackend);
      setPreviewTheme(themeFromBackend);
    }
  });

  const handleLogoChange = () => {
    // Invalidate appearance query to refresh the logo
    queryClient.invalidateQueries({ queryKey: organizationKeys.appearance() });
  };

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
        <LogoUpload
          currentLogo={logo}
          logoType={logoType}
          onLogoChange={handleLogoChange}
        />
        <ThemeSelector
          selectedTheme={currentUITheme}
          onThemeSelect={(themeId) => {
            setPreviewTheme(themeId);
            setHasChanges(themeId !== themeFromBackend);
          }}
        />
        {/* <FontSelector
          selectedFont={selectedFont}
          onFontSelect={setSelectedFont}
        /> */}
        {hasChanges && (
          <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
            <Button
              onClick={() => saveTheme(currentUITheme)}
              disabled={updateMutation.isPending}
            >
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setPreviewTheme(themeFromBackend || DEFAULT_THEME);
                setHasChanges(false);
              }}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
