"use client";

import type { OrganizationTheme } from "@archestra/shared";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsBlock } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { type ThemeMetadata, themes } from "@/themes";

interface ThemeSelectorProps {
  selectedTheme: OrganizationTheme | undefined;
  onThemeSelect: (themeId: OrganizationTheme) => void;
}

export function ThemeSelector({
  selectedTheme,
  onThemeSelect,
}: ThemeSelectorProps) {
  return (
    <SettingsBlock
      title="Color Theme"
      description="Choose a color theme for your organization. Changes are previewed in real-time."
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {themes.map((theme) => (
          <div key={theme.id} className="flex-1">
            <WithPermissions
              permissions={{ organizationSettings: ["update"] }}
              noPermissionHandle="tooltip"
              key={theme.id}
            >
              {({ hasPermission }) => (
                <ThemeOption
                  theme={theme}
                  isSelected={selectedTheme === theme.id}
                  onClick={() => onThemeSelect(theme.id)}
                  disabled={!hasPermission}
                />
              )}
            </WithPermissions>
          </div>
        ))}
      </div>
    </SettingsBlock>
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
  // Selection is the filled variant plus `aria-pressed`, deliberately without a
  // corner check: an icon positioned over a centered, full-width label lands on
  // the glyphs of any name wide enough to reach the tile edge, and the widest
  // name — "Caffeine (Default)" — is also the default selection.
  return (
    <Button
      variant={isSelected ? "default" : "outline"}
      className="h-auto p-3 flex-col items-center gap-2 w-full"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isSelected}
    >
      <span className="text-sm font-medium text-center w-full">
        {theme.name}
      </span>
    </Button>
  );
}
