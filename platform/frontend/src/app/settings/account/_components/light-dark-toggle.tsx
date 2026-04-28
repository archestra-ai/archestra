"use client";

import { getThemeRequiredMode, type ThemeId } from "@shared";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { LightDarkButtons } from "@/components/settings/light-dark-buttons";
import { Card, CardContent } from "@/components/ui/card";

interface LightDarkToggleProps {
  currentThemeId?: ThemeId;
}

export function LightDarkToggle({ currentThemeId }: LightDarkToggleProps) {
  const requiredMode = currentThemeId
    ? getThemeRequiredMode(currentThemeId)
    : null;
  const isLightOnly = requiredMode === "light";
  const isDarkOnly = requiredMode === "dark";

  return (
    <Card>
      <SettingsCardHeader
        title="Theme Mode"
        description={
          <>
            Switch between light and dark modes for your interface.
            {isLightOnly && " This theme only supports light mode."}
            {isDarkOnly && " This theme only supports dark mode."}
          </>
        }
      />
      <CardContent>
        <LightDarkButtons isLightOnly={isLightOnly} isDarkOnly={isDarkOnly} />
      </CardContent>
    </Card>
  );
}
