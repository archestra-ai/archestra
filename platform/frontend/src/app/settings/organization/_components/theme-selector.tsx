"use client";

import type { OrganizationTheme } from "@shared";
import { Check } from "lucide-react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { LightDarkButtons } from "@/components/settings/light-dark-buttons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { type ThemeMetadata, themes } from "@/themes";

interface ThemeSelectorProps {
  selectedTheme: OrganizationTheme | undefined;
  onThemeSelect: (themeId: OrganizationTheme) => void;
}

export function ThemeSelector({
  selectedTheme,
  onThemeSelect,
}: ThemeSelectorProps) {
  const selectedThemeMetadata = themes.find((t) => t.id === selectedTheme);
  const isLightOnly = selectedThemeMetadata?.mode === "light-only";
  const isDarkOnly = selectedThemeMetadata?.mode === "dark-only";

  function handleThemeSelect(themeMetadata: ThemeMetadata) {
    onThemeSelect(themeMetadata.id);
  }

  return (
    <Card>
      <SettingsCardHeader
        title="Color Theme"
        description="Choose a color theme for your organization. Changes are previewed in real-time."
        action={
          <LightDarkButtons
            isLightOnly={isLightOnly}
            isDarkOnly={isDarkOnly}
            size="sm"
          />
        }
      />
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {themes.map((themeItem) => (
            <div key={themeItem.id} className="flex-1">
              <WithPermissions
                permissions={{ organizationSettings: ["update"] }}
                noPermissionHandle="tooltip"
                key={themeItem.id}
              >
                {({ hasPermission }) => (
                  <ThemeOption
                    theme={themeItem}
                    isSelected={selectedTheme === themeItem.id}
                    onClick={() => handleThemeSelect(themeItem)}
                    disabled={!hasPermission}
                  />
                )}
              </WithPermissions>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface ThemeOptionProps {
  theme: ThemeMetadata;
  isSelected: boolean;
  onClick: () => void;
  disabled: boolean;
}

function ThemeOption({
  theme,
  isSelected,
  onClick,
  disabled,
}: ThemeOptionProps) {
  return (
    <Button
      variant={isSelected ? "default" : "outline"}
      className="h-auto p-3 flex-col items-center gap-2 relative w-full"
      onClick={onClick}
      disabled={disabled}
    >
      {isSelected && <Check className="h-4 w-4 absolute top-2 right-2" />}
      <span className="text-sm font-medium text-center w-full">
        {theme.name}
      </span>
    </Button>
  );
}
