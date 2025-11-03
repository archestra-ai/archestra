"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  organizationKeys,
  useOrganizationAppearance,
  useUpdateOrganizationAppearance,
} from "@/lib/organization.query";
import { FontSelector } from "./_components/font-selector";
import { LogoUpload } from "./_components/logo-upload";
import { ThemeSelector } from "./_components/theme-selector";

export default function AppearanceSettingsPage() {
  const { data: appearance, isLoading } = useOrganizationAppearance();
  const updateMutation = useUpdateOrganizationAppearance();
  const queryClient = useQueryClient();

  const [selectedTheme, setSelectedTheme] = useState(
    appearance?.theme || "cosmic-night",
  );
  const [selectedFont, setSelectedFont] = useState(
    appearance?.customFont || "lato",
  );
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (appearance) {
      setSelectedTheme(appearance.theme || "cosmic-night");
      setSelectedFont(appearance.customFont || "lato");
    }
  }, [appearance]);

  useEffect(() => {
    const themeChanged =
      selectedTheme !== (appearance?.theme || "cosmic-night");
    const fontChanged = selectedFont !== (appearance?.customFont || "lato");
    setHasChanges(themeChanged || fontChanged);
  }, [selectedTheme, selectedFont, appearance]);

  const handleSave = useCallback(async () => {
    await updateMutation.mutateAsync({
      theme: selectedTheme,
      customFont: selectedFont,
    });
    // Invalidate appearance query to refresh the data
    queryClient.invalidateQueries({ queryKey: organizationKeys.appearance() });
    setHasChanges(false);
  }, [selectedTheme, selectedFont, updateMutation, queryClient]);

  const handleReset = () => {
    setSelectedTheme(appearance?.theme || "cosmic-night");
    setSelectedFont(appearance?.customFont || "lato");
    setHasChanges(false);
  };

  const handleLogoChange = () => {
    // Invalidate appearance query to refresh the logo
    queryClient.invalidateQueries({ queryKey: organizationKeys.appearance() });
  };

  if (isLoading) {
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
          currentLogo={appearance?.logo}
          logoType={appearance?.logoType}
          onLogoChange={handleLogoChange}
        />
        <ThemeSelector
          selectedTheme={selectedTheme}
          onThemeSelect={setSelectedTheme}
        />
        <FontSelector
          selectedFont={selectedFont}
          onFontSelect={setSelectedFont}
        />
        {hasChanges && (
          <div className="flex gap-3 sticky bottom-6 bg-background p-4 rounded-lg border border-border shadow-lg">
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
            <Button
              variant="outline"
              onClick={handleReset}
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
