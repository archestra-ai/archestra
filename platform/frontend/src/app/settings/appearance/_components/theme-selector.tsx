"use client";

import type { OrganizationTheme } from "@shared";
import { Check } from "lucide-react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { type ThemeMetadata, themes } from "@/config/themes";

interface ThemeSelectorProps {
  selectedTheme: OrganizationTheme | undefined;
  onThemeSelect: (themeId: OrganizationTheme) => void;
}

export function ThemeSelector({
  selectedTheme,
  onThemeSelect,
}: ThemeSelectorProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Color Theme</CardTitle>
        <CardDescription>
          Choose a color theme for your organization. Changes are previewed in
          real-time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {themes.map((theme) => (
            <div key={theme.id} className="flex-1">
              <WithPermissions
                permissions={{ organization: ["update"] }}
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
