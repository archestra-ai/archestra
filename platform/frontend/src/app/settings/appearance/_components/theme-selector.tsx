"use client";

import type { OrganizationTheme } from "@shared";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getThemeCategories,
  getThemesByCategory,
  type Theme,
} from "@/config/themes";

interface ThemeSelectorProps {
  selectedTheme: OrganizationTheme;
  onThemeSelect: (themeId: OrganizationTheme) => void;
}

export function ThemeSelector({
  selectedTheme,
  onThemeSelect,
}: ThemeSelectorProps) {
  const categories = getThemeCategories();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Color Theme</CardTitle>
        <CardDescription>
          Choose a color theme for your organization
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {categories.map((category) => {
          const themes = getThemesByCategory(category.id);
          return (
            <div key={category.id} className="space-y-3">
              <h3 className="text-sm font-medium text-foreground">
                {category.label}
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {themes.map((theme) => (
                  <ThemeOption
                    key={theme.id}
                    theme={theme}
                    isSelected={selectedTheme === theme.id}
                    onClick={() => onThemeSelect(theme.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface ThemeOptionProps {
  theme: Theme;
  isSelected: boolean;
  onClick: () => void;
}

function ThemeOption({ theme, isSelected, onClick }: ThemeOptionProps) {
  return (
    <Button
      variant={isSelected ? "default" : "outline"}
      className="h-auto p-3 flex-col items-start gap-2 relative"
      onClick={onClick}
    >
      <div className="flex items-center gap-2 w-full">
        <div className="flex gap-1 flex-1">
          <div
            className="h-6 w-6 rounded-sm border border-border"
            style={{ background: theme.colors.dark.primary }}
          />
          <div
            className="h-6 w-6 rounded-sm border border-border"
            style={{ background: theme.colors.dark.secondary }}
          />
          {theme.colors.dark.accent && (
            <div
              className="h-6 w-6 rounded-sm border border-border"
              style={{ background: theme.colors.dark.accent }}
            />
          )}
        </div>
        {isSelected && <Check className="h-4 w-4" />}
      </div>
      <span className="text-xs font-normal text-left w-full">{theme.name}</span>
    </Button>
  );
}
