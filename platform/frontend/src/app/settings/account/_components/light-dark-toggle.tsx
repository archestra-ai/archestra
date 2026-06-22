"use client";

import { LightDarkButtons } from "@/components/settings/light-dark-buttons";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Card } from "@/components/ui/card";

export function LightDarkToggle() {
  return (
    <Card>
      <SettingsCardHeader
        title="Theme Mode"
        description="Switch between light and dark modes for your interface."
        action={<LightDarkButtons />}
      />
    </Card>
  );
}
